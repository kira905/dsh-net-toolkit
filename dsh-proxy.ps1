#Requires -Version 5.1
# dsh-proxy.ps1 - Clash Verge core proxy self-control for DSH v2
#
# Clash Verge Rev is normally installed under %ProgramFiles% (or %LOCALAPPDATA%\Programs)
#   - verge-mihomo.exe : the core (listens on 127.0.0.1:7897)
#   - clash-verge.exe  : the GUI (NOT launched by this script; core-only launch)
#   - config           : %APPDATA%\io.github.clash-verge-rev.clash-verge-rev\clash-verge.yaml
#
# v2 adds NODE SELECTION: the core is launched with -ext-ctl (TCP RESTful API)
# and -secret, so when egress fails we can query /proxies, latency-test nodes
# and switch the selector group to a working node automatically.
#
# Actions:
#   ensure (default) : if -TestUrl given, prefer direct first (domestic sources);
#                      otherwise ensure proxy port up + egress OK (auto-launch + node select)
#   status           : show process / port / egress test / current node
#   start            : force launch core (skips if already listening) then egress test + node select
#   stop             : stop core + GUI; refuses while dl-queue has active downloads unless -Force
#
# Options:
#   -TestUrl <url>   : custom target; ensure tests direct reach first, proxy as fallback
#   -NoTest          : skip egress test (launch/stop only)
#   -Force           : with stop, override active-download guard
#
# Exit codes: 0 = proxy ready / success, 1 = proxy unreachable / failure, 2 = guard refused (stop)

param(
  [ValidateSet('ensure', 'status', 'start', 'stop')]
  [string]$Action = 'ensure',
  [switch]$Force,
  [switch]$NoTest,
  [string]$TestUrl = ''
)

$ErrorActionPreference = 'Continue'

# ---------- dynamic core discovery (any Windows install layout) ----------

function Resolve-CoreExe {
  # 1) running core's own path (most reliable, any install location)
  $proc = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'verge-mihomo' } | Select-Object -First 1
  if ($proc -and $proc.Path -and (Test-Path $proc.Path)) { return $proc.Path }
  # 2) common install locations (Program Files / user-local)
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Clash Verge\verge-mihomo.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Clash Verge\verge-mihomo.exe')
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  return $null
}

$ProxyPort   = 7897
$ProxyUrl    = "http://127.0.0.1:$ProxyPort"
$CoreExe     = Resolve-CoreExe
$ConfigDir   = Join-Path $env:APPDATA 'io.github.clash-verge-rev.clash-verge-rev'
$ConfigFile  = Join-Path $ConfigDir 'clash-verge.yaml'
# DSH tools root: override with DSH_ROOT, else assume ~/DSH
$DshRoot     = if ($env:DSH_ROOT) { $env:DSH_ROOT } else { Join-Path $HOME 'DSH' }
$QueueFile   = Join-Path $DshRoot '_tmp\dl-queue\queue.json'
$StateDir    = Join-Path $env:TEMP 'dsh-proxy'
$StateFile   = Join-Path $StateDir 'state.json'
$CoreLog     = Join-Path $StateDir 'core.log'
$CtrlPortBase = 9099
$CtrlPortMax  = 9199
$ProbeTarget  = 'https://www.google.com'   # node latency test target
$MaxNodeTests = 25                        # sequential latency test cap (fallback path)
$WaitPortSec  = 40
$WaitStopSec  = 15

if ($TestUrl) {
  $TestTargets = @($TestUrl)
} else {
  $TestTargets = @('https://www.google.com', 'https://huggingface.co', 'https://github.com')
}

# ---------- primitives ----------

function Test-PortListening {
  return $null -ne (Get-NetTCPConnection -LocalPort $ProxyPort -State Listen -ErrorAction SilentlyContinue)
}

function Test-EgressViaProxy {
  # true if at least one target reachable through the proxy
  foreach ($u in $TestTargets) {
    $code = & curl.exe -x $ProxyUrl -s -o NUL -w '%{http_code}' --connect-timeout 8 --max-time 15 $u 2>$null
    if ($LASTEXITCODE -eq 0 -and $code -match '^[23]\d\d$') {
      Write-Host "  [proxy OK] $u (HTTP $code)"
      return $true
    }
    Write-Host "  [proxy FAIL] $u (exit=$LASTEXITCODE code=$code)"
  }
  return $false
}

function Test-DirectReach {
  foreach ($u in $TestTargets) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' --connect-timeout 6 --max-time 10 $u 2>$null
    if ($LASTEXITCODE -eq 0 -and $code -match '^[23]\d\d$') {
      Write-Host "  [direct OK] $u (HTTP $code)"
      return $true
    }
    Write-Host "  [direct FAIL] $u (exit=$LASTEXITCODE code=$code)"
  }
  return $false
}

function Get-ActiveDownloads {
  if (-not (Test-Path $QueueFile)) { return @() }
  try {
    $q = Get-Content $QueueFile -Raw -ErrorAction Stop | ConvertFrom-Json
    return @($q | Where-Object { $_.status -in @('active', 'running', 'downloading') })
  } catch {
    return @()
  }
}

# ---------- ext-ctl state ----------

$script:CtrlPort = 0
$script:CtrlSecret = ''

function Read-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try {
    $raw = [IO.File]::ReadAllText($StateFile)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-State {
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
  $core = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'verge-mihomo' } | Select-Object -First 1
  $st = @{
    pid      = if ($core) { $core.Id } else { 0 }
    ctrlPort = $script:CtrlPort
    secret   = $script:CtrlSecret
    at       = (Get-Date).ToString('o')
  } | ConvertTo-Json
  [IO.File]::WriteAllText($StateFile, $st, [Text.UTF8Encoding]::new($false))
}

function Clear-State {
  if (Test-Path $StateFile) { Remove-Item $StateFile -Force -ErrorAction SilentlyContinue }
}

function Get-FreeCtrlPort {
  for ($p = $CtrlPortBase; $p -le $CtrlPortMax; $p++) {
    if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { return $p }
  }
  return 0
}

function Invoke-CtrlApi {
  param([string]$Method, [string]$Path, [object]$Body)
  if ($script:CtrlPort -le 0 -or [string]::IsNullOrEmpty($script:CtrlSecret)) { return $null }
  $uri = "http://127.0.0.1:$($script:CtrlPort)$Path"
  $h = @{ Authorization = "Bearer $($script:CtrlSecret)" }
  try {
    if ($null -ne $Body) {
      return Invoke-RestMethod -Uri $uri -Method $Method -Headers $h -Body ($Body | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 12
    }
    return Invoke-RestMethod -Uri $uri -Method $Method -Headers $h -TimeoutSec 12
  } catch {
    return $null
  }
}

function Test-OurCore {
  # true if the running core is ours (ext-ctl API reachable with our state)
  $st = Read-State
  if (-not $st -or -not $st.ctrlPort -or -not $st.secret) { return $false }
  $script:CtrlPort = [int]$st.ctrlPort
  $script:CtrlSecret = [string]$st.secret
  $root = Invoke-CtrlApi -Method GET -Path '/proxies'
  return $null -ne $root -and $null -ne $root.proxies
}

# ---------- node selection ----------

function Test-NodeDelay {
  param([string]$Name)
  $enc = [uri]::EscapeDataString($Name)
  $r = Invoke-CtrlApi -Method GET -Path "/proxies/$enc/delay?url=$([uri]::EscapeDataString($ProbeTarget))&timeout=3000"
  if ($r -and $r.delay -gt 0) { return [int]$r.delay }
  return -1
}

function Test-GroupDelays {
  # mihomo extension: latency-test all nodes of a group concurrently
  param([string]$Group)
  $enc = [uri]::EscapeDataString($Group)
  return Invoke-CtrlApi -Method GET -Path "/group/$enc/delay?url=$([uri]::EscapeDataString($ProbeTarget))&timeout=3000"
}

function Set-GroupNode {
  param([string]$Group, [string]$Node)
  $enc = [uri]::EscapeDataString($Group)
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$($script:CtrlPort)/proxies/$enc" -Method PUT `
      -Headers @{ Authorization = "Bearer $($script:CtrlSecret)" } `
      -Body (@{ name = $Node } | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 8 | Out-Null
    Write-Host "[node] switched '$Group' -> '$Node'"
    return $true
  } catch {
    Write-Host "[node] switch failed: $($_.Exception.Message)"
    return $false
  }
}

function Select-WorkingNode {
  Write-Host "[node] egress failed - probing nodes via ext-ctl API ..."
  $root = Invoke-CtrlApi -Method GET -Path '/proxies'
  if (-not $root -or -not $root.proxies) {
    Write-Host "[node] ext-ctl API unavailable"
    return $false
  }
  $proxies = $root.proxies

  # collect Selector groups (skip built-in GLOBAL; sort by node count desc so
  # the main node-selection group (the one with the most nodes) is probed first)
  $groups = @()
  foreach ($p in $proxies.PSObject.Properties) {
    if ($p.Value.type -eq 'Selector' -and $p.Name -ne 'GLOBAL') {
      $groups += [pscustomobject]@{ Name = $p.Name; All = @($p.Value.all) }
    }
  }
  if ($groups.Count -eq 0) { Write-Host "[node] no Selector group found"; return $false }
  $groups = @($groups | Sort-Object { $_.All.Count } -Descending)

  # 1) fast path: concurrent group latency test (mihomo extension) - pick LOWEST latency
  foreach ($g in $groups) {
    $delays = Test-GroupDelays -Group $g.Name
    if ($null -eq $delays) { continue }
    $best = $null
    $bestDelay = [int]::MaxValue
    foreach ($d in $delays.PSObject.Properties) {
      $dv = [int]$d.Value
      if ($dv -gt 0 -and $dv -lt $bestDelay) { $bestDelay = $dv; $best = $d.Name }
    }
    if ($best) {
      Write-Host "[node] group '$($g.Name)': LOWEST latency = '$best' (${bestDelay}ms)"
      if (Set-GroupNode -Group $g.Name -Node $best) {
        return (Test-EgressViaProxy)
      }
    }
  }

  # 2) fallback: sequential probe up to MaxNodeTests candidates,
  #    collect ALL reachable and switch to the LOWEST latency one
  $candidates = @()
  foreach ($g in $groups) {
    foreach ($n in $g.All) {
      if ($n -notin $candidates) { $candidates += $n }
    }
  }
  $tested = 0
  $reachable = @()
  foreach ($n in $candidates) {
    if ($tested -ge $MaxNodeTests) { break }
    $tested++
    Write-Host "[node] testing '$n' ..."
    $d = Test-NodeDelay -Name $n
    if ($d -gt 0) { $reachable += [pscustomobject]@{ Name = $n; Delay = $d } }
  }
  if ($reachable.Count -gt 0) {
    $best = $reachable | Sort-Object Delay | Select-Object -First 1
    Write-Host "[node] LOWEST latency of $($reachable.Count) reachable = '$($best.Name)' ($($best.Delay)ms) - switching"
    foreach ($g in $groups) {
      if ($best.Name -in $g.All) { Set-GroupNode -Group $g.Name -Node $best.Name; break }
    }
    return (Test-EgressViaProxy)
  }
  Write-Host "[node] no working node found (tested $tested candidates)"
  return $false
}

# ---------- actions ----------

function Start-Proxy {
  if (Test-PortListening) {
    Write-Host "[proxy] port $ProxyPort already listening"
    if ($NoTest) { Write-Host "[proxy] READY"; return 0 }
    if (Test-EgressViaProxy) { Write-Host "[proxy] READY (egress OK)"; return 0 }
    Write-Host "[proxy] port up but egress FAILED"
    if (Test-OurCore) {
      Write-Host "[proxy] running core is ours - trying node selection"
      if (Select-WorkingNode) { Write-Host "[proxy] READY (node switched)"; return 0 }
    } else {
      Write-Host "[proxy] running core is Clash Verge GUI's - cannot switch nodes via API"
      Write-Host "[proxy] check GUI node selection, or stop the GUI core first (stop -Force)"
    }
    return 1
  }

  if (-not (Test-Path $CoreExe)) { Write-Host "[proxy] Clash Verge core not found (verge-mihomo.exe) - install Clash Verge Rev first (https://github.com/clash-verge-rev/clash-verge-rev)"; return 1 }
  if (-not (Test-Path $ConfigFile)) { Write-Host "[proxy] config not found: $ConfigFile - import a subscription in Clash Verge GUI first"; return 1 }

  $script:CtrlPort = Get-FreeCtrlPort
  if ($script:CtrlPort -le 0) { Write-Host "[proxy] no free ext-ctl port in $CtrlPortBase..$CtrlPortMax"; return 1 }
  $script:CtrlSecret = [guid]::NewGuid().ToString('N')
  New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

  Write-Host "[proxy] launching core: $CoreExe (ext-ctl 127.0.0.1:$($script:CtrlPort))"
  $launchArgs = @(
    '-d', $ConfigDir,
    '-f', $ConfigFile,
    '-ext-ctl', "127.0.0.1:$($script:CtrlPort)",
    '-secret', $script:CtrlSecret
  )
  Start-Process -FilePath $CoreExe -ArgumentList $launchArgs -WindowStyle Hidden `
    -RedirectStandardError $CoreLog | Out-Null

  $deadline = (Get-Date).AddSeconds($WaitPortSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortListening) { break }
    Start-Sleep -Milliseconds 500
  }

  if (-not (Test-PortListening)) {
    Write-Host "[proxy] core did not open port $ProxyPort within ${WaitPortSec}s - check $CoreLog"
    return 1
  }
  Write-Host "[proxy] port $ProxyPort is listening"
  Write-State
  if ($NoTest) { Write-Host "[proxy] READY"; return 0 }
  if (Test-EgressViaProxy) { Write-Host "[proxy] READY (egress OK)"; return 0 }

  Write-Host "[proxy] egress FAILED - selecting working node"
  if (Select-WorkingNode) {
    Write-Host "[proxy] READY (node switched)"
    return 0
  }
  Write-Host "[proxy] all nodes unreachable - check subscription"
  return 1
}

function Stop-Proxy {
  $active = @(Get-ActiveDownloads)
  if ($active.Count -gt 0 -and -not $Force) {
    Write-Host "[proxy] WARNING: $($active.Count) active download(s) in dl-queue; use -Force to override"
    return 2
  }

  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @('verge-mihomo', 'clash-verge') })
  if ($procs.Count -eq 0) {
    Write-Host "[proxy] no proxy processes running"
    Clear-State
    return 0
  }
  foreach ($p in $procs) {
    Write-Host "[proxy] stopping $($p.ProcessName) (pid $($p.Id))"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }

  $deadline = (Get-Date).AddSeconds($WaitStopSec)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PortListening)) { break }
    Start-Sleep -Milliseconds 500
  }
  Clear-State
  if (Test-PortListening) {
    Write-Host "[proxy] port still listening after stop"
    return 1
  }
  Write-Host "[proxy] stopped, port $ProxyPort closed"
  return 0
}

function Ensure-Proxy {
  # smart ensure: with a custom TestUrl, prefer direct first (domestic sources)
  if ($TestUrl) {
    Write-Host "[ensure] testing direct reach first (custom target)"
    if (Test-DirectReach) {
      Write-Host "[ensure] direct OK - no proxy needed"
      return 0
    }
    Write-Host "[ensure] direct failed - falling back to proxy"
  }
  return (Start-Proxy)
}

function Show-Status {
  $verge  = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'clash-verge' })
  $core   = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'verge-mihomo' })
  $listen = Test-PortListening

  Write-Host "=== proxy status ==="
  if ($verge.Count -gt 0) { Write-Host "GUI   : running (pids $($verge.Id -join ','))" } else { Write-Host "GUI   : not running" }
  if ($core.Count -gt 0)  { Write-Host "CORE  : running (pids $($core.Id -join ','))" }  else { Write-Host "CORE  : not running" }
  if ($listen) { Write-Host "PORT  : $ProxyPort LISTENING" } else { Write-Host "PORT  : $ProxyPort closed" }

  if ($listen -and -not $NoTest) {
    Write-Host "EGRESS (via $ProxyUrl):"
    $egress = Test-EgressViaProxy
    Write-Host $(if ($egress) { '==> proxy READY' } else { '==> port up but egress FAILED' })
  }

  if (Test-OurCore) {
    $node = Invoke-CtrlApi -Method GET -Path '/proxies'
    if ($node -and $node.proxies) {
      $sel = @()
      foreach ($p in $node.proxies.PSObject.Properties) {
        if ($p.Value.type -eq 'Selector' -and $p.Value.now) { $sel += "$($p.Name) -> $($p.Value.now)" }
      }
      if ($sel.Count -gt 0) { Write-Host "NODE  : $($sel -join ' | ')" }
    } else {
      Write-Host "NODE  : (ext-ctl reachable, no selector info)"
    }
  } elseif ($listen) {
    Write-Host "NODE  : (GUI core - not queryable without ext-ctl)"
  }

  if ($listen -and (-not $NoTest)) {
    return $(if ((Test-EgressViaProxy)) { 0 } else { 1 })
  }
  return $(if ($listen) { 0 } else { 1 })
}

# NOTE: never route function calls through `switch` branch assignments:
# a switch branch is a pipeline context, so `$x = <func>` captures ALL of the
# function's stdout into $x and swallows the output. Use an if/elseif chain.
$exitCode = 1
if ($Action -eq 'ensure') { $exitCode = Ensure-Proxy }
elseif ($Action -eq 'status') { $exitCode = Show-Status }
elseif ($Action -eq 'start') { $exitCode = Start-Proxy }
elseif ($Action -eq 'stop') { $exitCode = Stop-Proxy }
exit $exitCode
