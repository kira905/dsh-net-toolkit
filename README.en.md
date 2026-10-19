# dsh-net-toolkit · Networking & cross-host helpers for DSH

> Five everyday networking / cross-host tools from the DeepSeek Harness (DSH) ecosystem:
> **proxy self-control** (start/stop the Clash Verge core, pick a working node automatically),
> **Wake-on-LAN send + wake observation**, a **zero-dependency CDP client** (run JS / navigate in
> your already-logged-in Chrome), **page network capture** (poll frequency / long-lived requests /
> console errors), and an **OpenAI-compatible bridge for ComfyUI** (translates
> `/v1/images/generations` into ComfyUI workflows).
>
> **Node.js ≥ 18** (the two CDP tools need **≥ 22**) and **zero third-party runtime dependencies**
> (only `node:` built-ins). Windows first; `dsh-wol.mjs` and the CDP tools also run on Linux / macOS.

---

## ⚠️ Read this first (more important than any usage note)

1. **Most tools here have no help switch, and unknown arguments are silently ignored — then the real
   action runs.**
   - `cdp-net-capture.mjs`: positional #1 becomes **the URL to open/navigate**, positional #2 becomes
     seconds. One extra word may be treated as a URL.
   - `dsh-cdp.mjs`: positional #2 becomes **the JS expression to execute**.
   - `openai-bridge.mjs`: only `--port` / `--comfy` are read; anything else is ignored, then it
     **starts an HTTP server**.
   - `dsh-proxy.ps1`: `-Action start|stop` really **starts / kills** Clash Verge processes.
   ⇒ **Read the header comment (first 25 lines) of the script, or copy the parameter table below.**
2. **Two tools touch processes**: `dsh-proxy.ps1 stop` ends `verge-mihomo` and `clash-verge`;
   `openai-bridge.mjs` occupies a listening port. Make sure nothing else depends on them.
3. **Two tools execute code inside your logged-in browser**: `dsh-cdp.mjs eval` and
   `cdp-net-capture.mjs` talk to Chrome's DevTools port (9222). `eval` runs with **that page's
   logged-in privileges** — never paste a script you have not read.
4. **`dsh-wol.mjs` sends LAN broadcast packets**: use `--dry-run` (probe only) first.
5. No tool here reads any credential file or embeds any account/password; `dsh-wol.mjs` even
   requires an explicit MAC and IP.

---

## 1. Requirements & install

```powershell
# Node 18+ (CDP tools need 22+); no npm install required (zero dependencies)
node --version

# Run in place (from the repo root)
node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --dry-run

# Or install globally and use the bin names (the four Node tools)
npm i -g @kira905/dsh-net-toolkit
dsh-wol --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --dry-run
```

`dsh-proxy.ps1` is not installed as a bin; run it directly:

```powershell
pwsh -NoProfile -File .\dsh-proxy.ps1 -Action status
```

### Environment variables (all optional)

| Variable | Used by | Meaning | Default |
|---|---|---|---|
| `DSH_ROOT` | `dsh-proxy.ps1` | DSH workspace root (its `_tmp\dl-queue\queue.json` is the "downloads in flight" guard) | `~/DSH` |
| `CDP_PORT` | both CDP tools | Chrome remote-debugging port | `9222` |
| `CDP_MATCH` | `dsh-cdp.mjs` | pick a page by URL substring | empty ⇒ first page |
| `CDP_OUT` | `dsh-cdp.mjs` | write `eval` output to a file instead of stdout | unset ⇒ stdout |
| `COMFYUI_ROOT` | `openai-bridge.mjs` | ComfyUI install root (used to find `input/` and `models/`) | `~/ComfyUI` |
| `COMFYUI_INPUT` | `openai-bridge.mjs` | explicit ComfyUI `input` directory (reference images) | derived from `COMFYUI_ROOT` |
| `COMFYUI_MODELS` | `openai-bridge.mjs` | explicit ComfyUI `models` directory | derived from `COMFYUI_ROOT` |

> These tools grew inside a private Windows workspace with fixed drive letters and a fixed LAN.
> **The published version replaces every machine-absolute path with `DSH_ROOT` / `os.homedir()` /
> environment variables, and every real LAN IP, MAC and host name with placeholder examples;
> `dsh-wol.mjs` ships no default target at all.** Set `DSH_ROOT` (or accept `~/DSH`) on first use,
> and point `COMFYUI_ROOT` at your own ComfyUI install.

---

## 2. Repository layout (all files)

```
dsh-net-toolkit/
├── dsh-proxy.ps1               # Clash Verge core control + egress check + auto node selection (kills processes)
├── dsh-wol.mjs                 # Wake-on-LAN magic packets + wake observation (probe only, sends UDP)
├── dsh-cdp.mjs                 # zero-dependency CDP client: list / eval / eval-file / nav
├── cdp-net-capture.mjs         # capture page requests + long-lived requests + console errors (read-only)
├── openai-bridge.mjs           # ComfyUI ↔ OpenAI image API bridge (starts an HTTP server)
├── bridge-models.example.json  # model manifest example (copy to bridge-models.json)
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

---

## 3. Tool by tool

### 3.1 `dsh-proxy.ps1` — Clash Verge core control (starts / stops processes)

`ensure` checks the proxy port and the egress; if either fails it launches the Clash Verge **core**
(`verge-mihomo.exe`, not the GUI) with `-ext-ctl` and a random secret, then uses the core's RESTful
API to **latency-test a whole selector group and switch to the lowest-latency node**, then re-tests
the egress. With `-TestUrl` it tries **direct first** (prefer direct for domestic sources) and only
falls back to the proxy.

| Parameter | Meaning |
|---|---|
| `-Action ensure` | default: launch if needed, select a node, re-check egress |
| `-Action status` | read-only: GUI/core processes, port, egress, current node |
| `-Action start` | force-launch the core (skipped if already listening), then egress + node handling |
| `-Action stop` | stop core + GUI; refuses while downloads are active unless `-Force` |
| `-TestUrl <url>` | custom target: `ensure` tests direct reach first |
| `-NoTest` | skip the egress test (start/stop only) |
| `-Force` | `stop` ignores the active-download guard |

**Exit codes**: `0` proxy ready / success · `1` proxy unavailable / failure · `2` `stop` refused by
the download guard.

**State written**: `%TEMP%\dsh-proxy\state.json` (pid / control port / secret) and
`%TEMP%\dsh-proxy\core.log`. No config file is modified; subscriptions are untouched.

⚠️ `stop` kills both `verge-mihomo` and `clash-verge`; `-Force` does so even mid-download.

### 3.2 `dsh-wol.mjs` — Wake-on-LAN + wake observation

Probes the target first (TCP 22 by default). If it is already online, nothing is sent (exit `4`;
`--force` overrides). Otherwise it sends magic packets to the /24 broadcast address, to
255.255.255.255 and to the target unicast, on UDP ports 9 and 7, then probes every 3 s until the
watch window ends. **MAC and IP are mandatory** — the published build has no default target.

| Parameter | Meaning |
|---|---|
| `--mac <MAC>` | **required**, e.g. `AA-BB-CC-DD-EE-FF` (colons also accepted) |
| `--ip <IP>` | **required**, e.g. `203.0.113.10` (an RFC 5737 documentation address, not a real device) |
| `--probe-port <N>` | probe port (default 22; 80/443/3389 all work) |
| `--port <N>` | send only this UDP port (default: both 9 and 7) |
| `--rounds <N>` | packet rounds (default 3) |
| `--watch <sec>` | observation window (default 90) |
| `--local <IP>` | bind source address (multi-NIC hosts) |
| `--broadcast <IP>` | override the derived broadcast address |
| `--dry-run` | probe only, send nothing |
| `--force` | send even if the target is already online |
| `--no-watch` | return right after sending |
| `--json` | machine-readable output |

**Exit codes**: `0` wake confirmed · `3` sent but not observed / nothing sent · `4` already online ·
`2` bad arguments or environment.

⚠️ Broadcast packets reach every host on the segment; only wake machines you own and have enabled
WoL on.

### 3.3 `dsh-cdp.mjs` — zero-dependency CDP client

Connects to `127.0.0.1:9222`, lists targets, evaluates JS in the selected page via
`Runtime.evaluate` (awaits promises, returns by value), or navigates it. Handy for bulk-reading data
from a page you are already logged in to, with no Selenium/Playwright.

| Usage | Meaning |
|---|---|
| `node dsh-cdp.mjs list` | list targets (type / title / url / id) |
| `node dsh-cdp.mjs eval "<JS>"` | run JS in the selected page |
| `node dsh-cdp.mjs eval-file <path>` | same, JS read from a file |
| `node dsh-cdp.mjs nav <url>` | navigate the selected page |

Page selection: `CDP_MATCH` substring first, otherwise the first `page` target. Use
`CDP_OUT=<file>` for large results.

**Exit codes**: `0` ok · `1` cannot connect / page threw. Evaluate timeout is 60 s.

⚠️ Requires **Node.js ≥ 22** (global `WebSocket`).
⚠️ `eval` runs with the page's logged-in privileges.

### 3.4 `cdp-net-capture.mjs` — page network capture

Connects over CDP, enables `Network` + `Runtime`, navigates to the URL, waits `--settle` seconds
(optionally clicking one selector), captures for `--seconds` (default 25) and prints: total requests
to the target port, **per-endpoint counts for polling-style paths**, requests still open at the end
(long-lived / SSE), WebSockets, console errors/warnings, and one page-render health line.

Typical use: after a front-end or plugin change, measure on the same page whether poll frequency
dropped or new errors appeared.

| Parameter | Meaning |
|---|---|
| `<url>` (positional 1) | page to open, default `http://127.0.0.1:3080/` |
| `<seconds>` (positional 2) | capture window, default 25 |
| `--settle <sec>` | wait after navigation before capturing, default 12 |
| `--click <selector>` | click this CSS selector once before capturing (retries up to 10 s) |
| `--emulate-visible` | force the page to be treated as focused/visible |
| env `CDP_PORT` | Chrome debugging port, default 9222 |

**Read-only**: no page writes, no business write requests — only navigation, one optional DOM click,
and counter reads. Only requests to the **target URL's port** are counted (no hard-coded port).

### 3.5 `openai-bridge.mjs` — OpenAI-compatible bridge for ComfyUI

Serves a minimal OpenAI-compatible image API on `127.0.0.1:8199`:

| Endpoint | Meaning |
|---|---|
| `POST /v1/images/generations` (also `/images/generations`) | text-to-image; JSON or multipart |
| `POST /v1/images/edits` (also `/images/edits`) | image-to-image / reference image (IPAdapter) |
| `GET /v1/models` | list models; filters by whether the file exists under `COMFYUI_MODELS` |
| `GET /healthz` | liveness probe |

Body fields: `prompt`, `negative_prompt`, `model`, `size` (`1024x1024`, `16:9`, `1344x768`, …), `n`;
image jobs may include `image` (data URL or multipart file) and optionally override
`ipadapter_weight` / `ipadapter` / `clip_vision`.

| Parameter | Meaning |
|---|---|
| `--port <N>` | listen port, default 8199 |
| `--comfy <url>` | ComfyUI base URL, default `http://127.0.0.1:8188` |

**Model manifest**: read from `bridge-models.json` next to the script; when absent, two built-in
entries are used (`sd15` / `sdxl-base`). Copy `bridge-models.example.json` to `bridge-models.json`
and edit the checkpoint names. Entries with `kind: "zimage"` build the UNET/CLIP/VAE graph
(Z-Image family); everything else uses `CheckpointLoaderSimple`. **The Z-Image branch does not
support reference images** — it errors out and asks you to switch models; that is a model limit,
not a bug.

⚠️ Reference images are written as `ipadapter-ref-<ms>.png` into ComfyUI's `input/` directory
(`LoadImage` needs them there); clean up periodically. **Listens on 127.0.0.1 only.**

### 3.6 `bridge-models.example.json` — model manifest example

Two entries: `sd15` (`v1-5-pruned-emaonly-fp16.safetensors`) and `sdxl-base`
(`sd_xl_base_1.0.safetensors`). Fields:

| Field | Meaning |
|---|---|
| `id` | public model id (the request's `model`) |
| `checkpoint` | filename under `models\checkpoints` |
| `steps` / `cfg` / `sampler` / `scheduler` | sampling parameters |
| `positive` / `negative` | fixed prompt prefix/suffix |
| `ipadapter` / `clip_vision` / `ipadapter_weight` | image-to-image consistency (optional) |
| `extend_clip_vision` | insert `EXTEND_CLIP_VISION_INPUT_SIZE` (448×448 patch) |
| `kind: "zimage"` + `diffusion` / `text_encoder` / `vae` / `auraflow_shift` | Z-Image family only |

> `bridge-models.json` itself is git-ignored: it is **your** real model list and does not belong in
> the repository.

---

## 4. What is deliberately not included

Three "phone access channel" tools from the same private deployment are **not** published:

| Not included | What it did | Why not published |
|---|---|---|
| `dsh-phone.mjs` | one switch for the phone channel: reverse proxy + Cloudflare quick tunnel + printed phone URL | It **extracts the per-restart random web token from the app's startup log**, splices it into the URL, and manages Basic Auth credentials; it also hard-codes private deployment log paths. That is real credential-extraction and assembly logic — strip it and nothing useful remains; keep it and you leak the method. |
| `dsh-phone-proxy.mjs` | reverse proxy for the phone channel (Basic Auth + WebSocket forwarding) | It **rewrites Host/Origin to loopback to bypass the app's own trusted-host fence**. Shipping a "bypass the security fence" recipe as a general utility invites unauthorised-exposure copies; it is also a set with the item above. |
| `dsh-phone-tunnel.ps1` | starts a cloudflared tunnel and records the current URL in a local state file | Part of the same set; meaningless alone without the proxy and credential assembly. |

Also **not published**: `bridge-models.json` (a real local model list with personal model ids).
Only `bridge-models.example.json` ships.

> Rule of thumb: **ship less rather than leak.** Readers can write a ten-line tunnel script
> themselves; they should not inherit a ready-made "extract the token / bypass the fence" implementation.

---

## 5. Integration points with DSH

- `dsh-proxy.ps1 stop` reads `$DSH_ROOT\_tmp\dl-queue\queue.json` to honour "downloads in flight" —
  that is DSH's download queue file; without it the guard simply does not trigger.
- `cdp-net-capture.mjs` opens `http://127.0.0.1:3080/` by default (the DSH web GUI), and its polling
  buckets (`task-status`, `imagegen/tasks`, `download-progress`, `task-board/state`) are DSH panel
  endpoints.
- `openai-bridge.mjs` exists to be a "local image model channel" for the `dsh-imagegen` plugin:
  add an OpenAI-compatible channel pointing at `http://127.0.0.1:8199/v1`.
- `dsh-wol.mjs` and `dsh-cdp.mjs` are generic and have no DSH coupling.

---

## 6. License

This repository is released under **AGPL-3.0 + a commercial license** (dual licensing); see
[LICENSE](LICENSE). In short: **either use/modify under AGPL-3.0 and keep derivatives open, or
obtain a commercial license.** (AGPL itself does not forbid commercial use; "+ commercial license"
is dual licensing, not a non-commercial clause.)

---

## 7. Changelog

See [CHANGELOG.md](CHANGELOG.md). First public release: `v0.1.0` (2026-10-19).
