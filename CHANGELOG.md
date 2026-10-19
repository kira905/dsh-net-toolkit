# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.1.0] - 2026-10-19

### Added

- **`dsh-proxy.ps1`** — Clash Verge core self-control for DSH: `ensure` / `status` / `start` / `stop`;
  dynamic core discovery (running process path first, then common install locations); launches the
  core only (never the GUI) with `-ext-ctl` + a per-run random secret; egress check via `curl.exe`;
  concurrent selector-group latency test through the core's RESTful API, then switches to the
  lowest-latency node and re-checks; `-TestUrl` prefers direct reach for domestic sources;
  `stop` refuses while a download queue has active entries unless `-Force`. Exit codes `0/1/2`.
- **`dsh-wol.mjs`** — Wake-on-LAN magic-packet sender plus wake observation: probe first (TCP port,
  default 22), send to derived /24 broadcast + 255.255.255.255 + target unicast on UDP 9/7 for N
  rounds, then poll until the watch window ends; `--dry-run`, `--force`, `--no-watch`, `--json`;
  exit codes `0/3/4/2`. **MAC and IP are required arguments.**
- **`dsh-cdp.mjs`** — zero-dependency Chrome DevTools Protocol client: `list` / `eval` / `eval-file` /
  `nav`; page selection by `CDP_MATCH` substring; `CDP_OUT` for large results; 60 s evaluate timeout.
- **`cdp-net-capture.mjs`** — capture page network activity for a fixed window: requests per path,
  polling-style endpoints sorted by count, requests still open at the end (SSE / long-lived),
  WebSockets, console errors/warnings (deduplicated), and one page-render health line;
  `--settle`, `--click <selector>`, `--emulate-visible`.
- **`openai-bridge.mjs`** — OpenAI-compatible bridge in front of ComfyUI: `/v1/models`,
  `/v1/images/generations`, `/v1/images/edits` (JSON or multipart), `/healthz`; SDXL/SD1.5 graph via
  `CheckpointLoaderSimple`, Z-Image graph via UNET/CLIP/VAE; optional IPAdapter reference-image path;
  listens on `127.0.0.1` only; model manifest from `bridge-models.json` with two built-in fallbacks.
- **`bridge-models.example.json`** — two-entry model manifest example (`sd15`, `sdxl-base`).
- `package.json` with `bin` entries for the four Node tools, AGPL-3.0 + commercial dual licensing.

### Changed (relative to the private source tree)

- All machine-absolute paths replaced with `DSH_ROOT` / `os.homedir()` / `COMFYUI_ROOT` /
  `COMFYUI_INPUT` / `COMFYUI_MODELS`; host names and device short codes generalized.
- **`dsh-wol.mjs` no longer ships a default target.** The private build defaulted to one real LAN
  host (fixed MAC + IP, and its SSH port as the probe port). The published build requires `--mac` and
  `--ip` and exits `2` with a usage line when either is missing; help text uses
  `AA-BB-CC-DD-EE-FF` / `203.0.113.10`.
- **`dsh-cdp.mjs` no longer prefers a business site.** The private build defaulted the page-matching
  string to one internal site key; the published build takes the first `page` target unless
  `CDP_MATCH` is set.
- **`cdp-net-capture.mjs` derives the counted port from the target URL** instead of hard-coding one
  port number; the printed line now shows the actual port. (In the private build, pointing the tool
  at any other port silently produced an empty reading.)
- **`openai-bridge.mjs` ComfyUI roots are configurable** (`COMFYUI_ROOT` default `~/ComfyUI`, plus
  `COMFYUI_INPUT` / `COMFYUI_MODELS` overrides) instead of two hard-coded drive-letter paths; the
  models-root lookup probes `models/` and `ComfyUI/models/` under the root.
- **`dsh-proxy.ps1` download-queue path is derived from `DSH_ROOT`** (default `~/DSH`); the
  selector-group example comment no longer names a private subscription group.

### Not included

- `dsh-phone.mjs`, `dsh-phone-proxy.mjs`, `dsh-phone-tunnel.ps1` — the phone-access channel set.
  It contains tunnel control, Basic Auth handling, extraction of a per-restart web token from the
  app's startup log, and a Host/Origin rewrite that bypasses the app's trusted-host fence. These are
  deliberately not published; see README section 4.
- `bridge-models.json` — the real local model list is replaced by `bridge-models.example.json`.

### Known limits

- The two CDP tools require **Node.js ≥ 22** (global `WebSocket`); `package.json` `engines` stays at
  `>=18` because the other three tools work there.
- `openai-bridge.mjs`'s Z-Image branch does not support reference images (model capability limit).
- `dsh-proxy.ps1` is Windows + Clash Verge Rev specific (config path and `curl.exe` usage).
