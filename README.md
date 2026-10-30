# dsh-net-toolkit · DSH 网络与跨机小工具

> **本仓是命令行工具，不挂宿主界面，不需要 `dsh.bundle`、不需要写 `cordis.patch.yml`。** 装它 = `npm i -g @kira905/dsh-net-toolkit`（或 `npx -p @kira905/dsh-net-toolkit dsh-wol`）。装进 profile 也对，但那条 `declares no dsh.bundle` 警告是**正常现象**，不是故障。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-net-toolkit"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-net-toolkit —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-net-toolkit"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-net-toolkit）

# ③ 命令在不在 —— 【只查存在，不执行】
Test-Path <数据根>/profiles/<profile>/node_modules/.bin/dsh-wol.CMD   # 装进 profile 的
Test-Path "$env:APPDATA\npm\dsh-wol.CMD"                           # npm i -g 装的
# 期望：True。两条路径按你实际用的装法挑一条
```

> 探针只做存在性检查（只看命令文件在不在，不执行任何命令）。
> 要不要用 `--help` 验，见本仓当前说明与该命令的参数表。

---

> DeepSeek Harness（DSH）生态里**天天在用的五件网络/跨机工具**：
> **代理自控**（Clash Verge 核心起停 + 自动挑可用节点）、
> **Wake-on-LAN 唤醒 + 唤醒观测**、
> **零依赖 CDP 客户端**（在已登录的 Chrome 页面里执行 JS / 导航）、
> **页面网络抓包对照**（轮询频率 / 长连接 / 控制台报错）、
> **ComfyUI 的 OpenAI 兼容桥**（把 `/v1/images/generations` 翻译成 ComfyUI 工作流）。
>
> 全部 **Node.js ≥ 18**（CDP 两件需 **≥ 22**）、**零第三方运行时依赖**（只用 `node:` 内置模块）。
> Windows 优先；`dsh-wol.mjs` / CDP 两件在 Linux / macOS 上同样可用。

---

## ⚠️ 先读这段（比任何用法都重要）

1. **本仓多数工具没有帮助开关；不认识的参数会被静默忽略，然后直接执行真动作。**
   - `cdp-net-capture.mjs`：第一个位置参数直接当 **要打开/导航的 URL**，第二个当秒数。多敲一个词，
     它可能把那个词当 URL 去导航。
   - `dsh-cdp.mjs`：第二个位置参数直接当 **要执行的 JS 表达式**。
   - `openai-bridge.mjs`：只认 `--port` / `--comfy`，别的参数被忽略，然后**直接起 HTTP 服务**。
   - `dsh-proxy.ps1`：`-Action start|stop` 会**真起 / 真杀** Clash Verge 进程。
   ⇒ **先读脚本头部注释（前 25 行），或照本文件的逐件表抄参数。** 别靠"试一下"。
2. **有两件会动进程**：`dsh-proxy.ps1` 的 `stop` 会结束 `verge-mihomo` 与 `clash-verge` 进程；
   `openai-bridge.mjs` 会占用监听端口。跑之前确认没有别的下载/隧道在依赖它们。
3. **有两件在你已登录的浏览器里执行代码**：`dsh-cdp.mjs eval` 与 `cdp-net-capture.mjs` 通过
   Chrome DevTools Protocol 连本机 9222 端口。`eval` 的权限 = **那个已登录页面的权限**，
   别看都没看就粘一段网上抄来的 JS 进去。
4. **`dsh-wol.mjs` 会往局域网发广播包**：先用 `--dry-run` 只探活，确认目标再真发。
5. 本仓工具**不读任何凭据文件、不内置任何账号口令**；`dsh-wol.mjs` 连 MAC/IP 都要求显式传。

---

## 1. 环境与安装

```powershell
# Node 18+（CDP 两件需 22+）；无需 npm install（零依赖）
node --version

# 直接用（在仓根）
node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --dry-run

# 或者装到全局用 bin 名（四件 Node 工具）
npm i -g @kira905/dsh-net-toolkit
dsh-wol --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --dry-run
```

`dsh-proxy.ps1` 不装 bin，直接：

```powershell
pwsh -NoProfile -File .\dsh-proxy.ps1 -Action status
```

### 环境变量（都可选）

| 变量 | 用在 | 含义 | 缺省 |
|---|---|---|---|
| `DSH_ROOT` | `dsh-proxy.ps1` | DSH 工作区根（找 `_tmp\dl-queue\queue.json` 判"有没有下载在跑"） | `~/DSH` |
| `CDP_PORT` | CDP 两件 | Chrome 远程调试端口 | `9222` |
| `CDP_MATCH` | `dsh-cdp.mjs` | 按 URL 子串挑页面 | 空 ⇒ 第一个 page |
| `CDP_OUT` | `dsh-cdp.mjs` | 把 `eval` 结果写文件而不是打印 | 不设 ⇒ 打印 |
| `COMFYUI_ROOT` | `openai-bridge.mjs` | ComfyUI 安装根（下面找 `input/`、`models/`） | `~/ComfyUI` |
| `COMFYUI_INPUT` | `openai-bridge.mjs` | 直接指定 ComfyUI `input` 目录（写参考图用） | 由 `COMFYUI_ROOT` 推 |
| `COMFYUI_MODELS` | `openai-bridge.mjs` | 直接指定 ComfyUI `models` 目录（判模型文件在不在） | 由 `COMFYUI_ROOT` 推 |

> 这几件原本长在一棵私有工作树里（Windows、有固定盘符与固定局域网）。**发布版已把所有本机绝对路径
> 换成 `DSH_ROOT` / `os.homedir()` / 环境变量，把真实内网 IP、MAC、机器名换成占位示例；
> `dsh-wol.mjs` 干脆不内置默认目标。** 第一次在自己机器上用，先设 `DSH_ROOT`（或接受 `~/DSH`），
> `openai-bridge.mjs` 则按你的 ComfyUI 安装位置设 `COMFYUI_ROOT`。

---

## 2. 仓库结构（全量文件）

```
dsh-net-toolkit/
├── dsh-proxy.ps1               # Clash Verge 核心起停 + 出口自检 + 自动挑节点（会杀进程）
├── dsh-wol.mjs                 # Wake-on-LAN 魔术包 + 唤醒观测（只读探测，发的是 UDP 广播）
├── dsh-cdp.mjs                 # 零依赖 CDP 客户端：list / eval / eval-file / nav
├── cdp-net-capture.mjs         # 抓一段时间的网络请求 + 长连接 + 控制台报错（只读）
├── openai-bridge.mjs           # ComfyUI ↔ OpenAI 图片接口兼容桥（起 HTTP 服务）
├── bridge-models.example.json  # 上面那件的模型清单示例（复制成 bridge-models.json 用）
├── README.md
├── README.en.md
├── CHANGELOG.md
├── LICENSE
├── package.json
├── .gitignore
└── .gitattributes
```

---

## 3. 逐件说明

### 3.1 `dsh-proxy.ps1` —— Clash Verge 核心自控（会起停进程）

**它解决什么**：`ensure` 先看代理端口通不通、出口通不通；不通就拉起 Clash Verge 的**核心**
（`verge-mihomo.exe`，不拉 GUI），并带 `-ext-ctl` + 随机 secret 启动，然后通过核心的 RESTful API
**并发测一组节点的延迟、切到最低延迟的那个**，再复测出口。给 `-TestUrl` 时**先试直连**（国内源直连优先），
直连不通才走代理。

| 参数 | 说明 |
|---|---|
| `-Action ensure` | 默认。必要时拉起核心 + 选节点 + 复测出口 |
| `-Action status` | 只读：GUI/核心进程、端口、出口、当前节点 |
| `-Action start` | 强制拉起核心（已在听则跳过）后做出口与节点处理 |
| `-Action stop` | 停核心 + GUI；有下载在跑时**拒绝**（除非 `-Force`） |
| `-TestUrl <url>` | 自定义目标：`ensure` 先测直连 |
| `-NoTest` | 跳过出口测试（只起停） |
| `-Force` | `stop` 时忽略"有下载在跑"的保护 |

**退出码**：`0` 代理就绪/成功 · `1` 代理不可用/失败 · `2` `stop` 被下载保护拒绝。

**写什么**：状态文件在 `%TEMP%\dsh-proxy\state.json`（pid / 控制端口 / secret），核心 stderr 在
`%TEMP%\dsh-proxy\core.log`。**不写任何配置文件**，不改 Clash 订阅。

⚠️ `stop` 会把 `verge-mihomo` 与 `clash-verge` 一起结束；`-Force` 会在有下载时照样杀。

### 3.2 `dsh-wol.mjs` —— Wake-on-LAN 发包 + 唤醒观测

**它做什么**：先探活目标（默认 TCP 22）；目标已在线则不发包（退出码 `4`，可用 `--force` 强发）；
否则向「按 /24 推出来的广播地址 + 255.255.255.255 + 目标单播」在 9/7 端口发若干轮魔术包，
然后每 3 秒探一次，直到超时。**MAC 与 IP 必须显式传**（发布版不内置任何目标）。

| 参数 | 说明 |
|---|---|
| `--mac <MAC>` | **必填**，例 `AA-BB-CC-DD-EE-FF`（也接受 `aa:bb:...`） |
| `--ip <IP>` | **必填**，目标 IP，例 `203.0.113.10`（RFC 5737 文档保留地址，不是真实设备） |
| `--probe-port <N>` | 探活端口（默认 22；改成 80/443/3389 等均可） |
| `--port <N>` | 只发这一个 UDP 端口（默认 9 与 7 都发） |
| `--rounds <N>` | 发包轮数（默认 3） |
| `--watch <秒>` | 发包后观测时长（默认 90） |
| `--local <IP>` | 指定本机源地址（多网卡时手动选链路） |
| `--broadcast <IP>` | 指定广播地址（默认按 /24 推导） |
| `--dry-run` | 只探活，不发包 |
| `--force` | 目标已在线也照发（验证发送链路） |
| `--no-watch` | 发完即退 |
| `--json` | 输出 JSON |

**退出码**：`0` 已确认唤醒 · `3` 发了包但没观测到唤醒 / 一个包都没发出去 · `4` 发包前目标已在线 · `2` 参数或环境错误。

⚠️ 广播出去的魔术包**任何同网段设备都能收到**；只对你自己管理、且已启用 WOL 的机器发。

### 3.3 `dsh-cdp.mjs` —— 零依赖 CDP 客户端

**它做什么**：连 `127.0.0.1:9222` 的 Chrome，列出页面、在选中页面里 `Runtime.evaluate` 一段 JS、
或让它导航。适合"在已登录的页面上批量取数"——不用 Selenium / Playwright，也不需要额外依赖。

| 用法 | 说明 |
|---|---|
| `node dsh-cdp.mjs list` | 列出所有 target（type / title / url / id） |
| `node dsh-cdp.mjs eval "<JS>"` | 在选中页面里执行一段 JS，等 Promise，按值返回 |
| `node dsh-cdp.mjs eval-file <路径>` | 同上，JS 从文件读（长脚本用这个） |
| `node dsh-cdp.mjs nav <url>` | 让选中页面导航到 url |

选页优先级：`CDP_MATCH` 子串命中 → 第一个 `page`。结果超过一屏/要塞进管道时用 `CDP_OUT=<文件>`。

**退出码**：`0` 成功 · `1` 连不上 / 页面抛异常。**超时** 60 秒（`Runtime.evaluate` 单次）。

⚠️ 需要 **Node.js ≥ 22**（用了全局 `WebSocket`）。
⚠️ `eval` 的权限就是那个页面已登录身份的权限——别执行来路不明的脚本。

### 3.4 `cdp-net-capture.mjs` —— 页面网络抓包对照

**它做什么**：连 CDP → `Network.enable` + `Runtime.enable` → 导航到目标 URL → 等 `--settle` 秒（可选点一下某个元素）
→ 抓 `--seconds` 秒（默认 25）→ 打印：打到目标端口的请求总数、**轮询类端点各被调了多少次**、
观测结束时还没结束的请求（长连接/SSE）、WebSocket、控制台 error/warning、以及页面渲染健康度一行。

典型用途：改了一轮前端/插件之后，用同一张页面量"轮询频率有没有降下来"、"有没有新报错"。

| 参数 | 说明 |
|---|---|
| `<url>`（位置 1） | 要打开的页面，默认 `http://127.0.0.1:3080/` |
| `<seconds>`（位置 2） | 观测秒数，默认 25 |
| `--settle <秒>` | 导航后先等多久再开始观测，默认 12 |
| `--click <selector>` | 观测前在页面里点一次该 CSS 选择器（最多重试 10 秒） |
| `--emulate-visible` | 强制让页面被当成"聚焦可见"（最小化窗口会影响 visibilityState） |
| env `CDP_PORT` | Chrome 调试端口，默认 9222 |

**只读声明**：不写页面、不发业务写请求；只做「导航 + 可选的一次 DOM 点击 + 读 counters」。
统计只算打到**目标 URL 端口**的请求（不再写死某个端口）。

### 3.5 `openai-bridge.mjs` —— ComfyUI 的 OpenAI 兼容桥

**它做什么**：在 `127.0.0.1:8199` 起一个 HTTP 服务，实现图片生成的最小 OpenAI 兼容面：

| 端点 | 说明 |
|---|---|
| `POST /v1/images/generations`（也接受 `/images/generations`） | 文生图；JSON 或 multipart |
| `POST /v1/images/edits`（也接受 `/images/edits`） | 图生图 / 参考图（走 IPAdapter） |
| `GET /v1/models` | 列出模型；会先用 `COMFYUI_MODELS` 判模型文件在不在 |
| `GET /healthz` | 存活探针 |

请求体：`prompt` / `negative_prompt` / `model` / `size`（`1024x1024`、`16:9`、`1344x768`…）/ `n`；
图生图额外带 `image`（data URL 或 multipart 文件）；可选覆盖 `ipadapter_weight` / `ipadapter` / `clip_vision`。

| 参数 | 说明 |
|---|---|
| `--port <N>` | 监听端口，默认 8199 |
| `--comfy <url>` | ComfyUI 地址，默认 `http://127.0.0.1:8188` |

**模型清单**：读同目录的 `bridge-models.json`；没有就用内置两条（`sd15` / `sdxl-base`）。
把 `bridge-models.example.json` 复制成 `bridge-models.json` 再按你的 checkpoint 文件名改。
`kind: "zimage"` 的分支走 UNET/CLIP/VAE 三件套（Z-Image 系），其余走 CheckpointLoaderSimple。
**Z-Image 分支不支持参考图**（会直接报错让你换模型），这是模型能力边界，不是 bug。

⚠️ 参考图会以 `ipadapter-ref-<毫秒>.png` 写进 ComfyUI 的 `input/` 目录（LoadImage 要读它）；
跑久了记得清。**只监听 127.0.0.1**，不对外网开放。

### 3.6 `bridge-models.example.json` —— 模型清单示例

两条示例：`sd15`（`v1-5-pruned-emaonly-fp16.safetensors`）与 `sdxl-base`（`sd_xl_base_1.0.safetensors`）。
字段含义：

| 字段 | 说明 |
|---|---|
| `id` | 对外暴露的模型 id（请求里的 `model`） |
| `checkpoint` | `models\checkpoints` 下的文件名 |
| `steps` / `cfg` / `sampler` / `scheduler` | 采样参数 |
| `positive` / `negative` | 固定前缀/后缀提示词 |
| `ipadapter` / `clip_vision` / `ipadapter_weight` | 图生图一致性（可选） |
| `extend_clip_vision` | 是否插 `EXTEND_CLIP_VISION_INPUT_SIZE`（448 方图补丁） |
| `kind: "zimage"` + `diffusion` / `text_encoder` / `vae` / `auraflow_shift` | Z-Image 系专用 |

> `bridge-models.json` 本身被 `.gitignore` 排除——它是**你本机的真实模型清单**，不该进仓。

---

## 4. 未包含的工具（以及为什么）

本仓刻意**不包含**三件"手机访问通道"工具。它们来自同一套私有部署，且成套依赖：

| 未包含 | 它原本做什么 | 为什么不发布 |
|---|---|---|
| `dsh-phone.mjs` | 手机通道统一开关：起反代 + 拉 Cloudflare 快速隧道 + 打印手机地址 | 它需要**从应用启动日志里取出每次随机生成的 web token**，把它拼进访问链接，并维护 Basic Auth 口令；还硬编码了私有部署的日志布局。里面是真实的凭据取值与拼装逻辑 ⇒ 删干净就只剩空壳，留着就是泄凭据。 |
| `dsh-phone-proxy.mjs` | 手机通道反代（Basic Auth + 转发 WebSocket） | 它靠**改写 Host/Origin 成 loopback 来绕过应用自身的 trusted-host 栅栏**。这类"绕过安全栅栏"的手法不适合当通用工具散发（容易被照抄去做未授权暴露），且与上一件成套。 |
| `dsh-phone-tunnel.ps1` | 拉起 cloudflared 隧道并把当前 URL 写进本机状态文件 | 同属三件套，离开上面的反代与凭据拼装单独发布没有意义。 |

另外**不发布** `bridge-models.json`（本机真实模型清单，含个人偏好模型 id），只发布
`bridge-models.example.json`。

> 判断口径：**宁可少发，不许泄露**。宁可让读者自己写十行隧道脚本，也不让"取 token / 绕栅栏"的
> 现成实现流出去。

---

## 5. 与 DSH 的集成点

- `dsh-proxy.ps1` 的 `stop` 会读 `$DSH_ROOT\_tmp\dl-queue\queue.json` 判断"有没有下载在跑"——
  这是 DSH 下载调度器的队列文件；没有它时该保护自然失效（直接停）。
- `cdp-net-capture.mjs` 默认打开 `http://127.0.0.1:3080/`（DSH Web GUI 的默认地址），
  它统计的 `task-status` / `imagegen/tasks` / `download-progress` / `task-board/state` 是 DSH 面板的轮询端点。
- `openai-bridge.mjs` 就是给 `dsh-imagegen` 插件当"本地图片模型渠道"用的：插件配一个 OpenAI 兼容渠道，
  地址填 `http://127.0.0.1:8199/v1`。
- `dsh-wol.mjs` 与 `dsh-cdp.mjs` 跟 DSH 无耦合，纯通用件。

---

## 6. 许可

本仓代码以 **AGPL-3.0 + 商业授权**（双许可）发布，详见 [LICENSE](LICENSE)。
简言之：**要么按 AGPL-3.0 使用/修改并让衍生作品同样开源，要么取得商业授权**。
（AGPL 本身不禁止商用；「+ 商业授权」是双许可，不是禁商用条款。）

---

## 7. 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。首个公开版本 `v0.1.0`（2026-10-19）。
