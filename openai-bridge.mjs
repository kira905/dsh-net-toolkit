// openai-bridge.mjs - ComfyUI OpenAI 兼容桥（跨平台通用版）
// 监听 8199，把 dsh-imagegen 的 /v1/images/generations 请求翻译成 ComfyUI 工作流
// 用法：node openai-bridge.mjs [--port 8199] [--comfy http://127.0.0.1:8188]
// 模型配置见同目录 bridge-models.json（checkpoint 文件名 / 采样参数）—— 从
// bridge-models.example.json 复制一份改名即可（本仓不发布任何真实模型清单）
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pi = process.argv.indexOf('--port');
const ci = process.argv.indexOf('--comfy');
const PORT = (pi >= 0 && Number(process.argv[pi + 1])) || 8199;
const COMFY = (ci >= 0 && process.argv[ci + 1]) || 'http://127.0.0.1:8188';
const TOOL_DIR = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'));
const CFG_PATH = path.join(TOOL_DIR, 'bridge-models.json');

const defaultModels = [
  {
    id: 'sd15',
    checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
    steps: 25, cfg: 7, sampler: 'euler', scheduler: 'normal',
    positive: '', negative: '',
  },
  {
    id: 'sdxl-base',
    checkpoint: 'sd_xl_base_1.0.safetensors',
    steps: 28, cfg: 6, sampler: 'euler', scheduler: 'normal',
    positive: 'masterpiece, best quality, anime style', negative: 'lowres, bad anatomy, bad hands, text, watermark',
  },
];

function loadModels() {
  try {
    if (fs.existsSync(CFG_PATH)) return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')).models || defaultModels;
  } catch (e) { console.error('[bridge] config read failed:', e.message); }
  return defaultModels;
}

function mapSize(size) {
  const s = (size || '1024x1024').toLowerCase();
  if (s.includes('16:9') || s.includes('1344x768')) return [1344, 768];
  if (s.includes('9:16') || s.includes('768x1344')) return [768, 1344];
  if (s.includes('3:4') || s.includes('768x1024')) return [768, 1024];
  if (s.includes('4:3') || s.includes('1024x768')) return [1024, 768];
  if (s.includes('1:1')) return [1024, 1024];
  const m = s.match(/^(\d+)x(\d+)$/);
  if (m) return [Math.min(1344, Number(m[1])), Math.min(1344, Number(m[2]))];
  return [1024, 1024];
}

function comfyRoot() {
  return process.env.COMFYUI_ROOT || path.join(os.homedir(), 'ComfyUI');
}

function findInputDir() {
  if (process.env.COMFYUI_INPUT) return process.env.COMFYUI_INPUT;
  const root = comfyRoot();
  const cands = [path.join(root, 'input'), path.join(root, 'ComfyUI', 'input')];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return cands[0];
}

// 保存参考图 base64 到 ComfyUI input 目录，返回文件名（LoadImage 用）
function saveRefImage(b64) {
  let data = b64;
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/.exec(b64);
  if (m) data = m[1];
  const buf = Buffer.from(data, 'base64');
  const name = 'ipadapter-ref-' + Date.now() + '.png';
  fs.writeFileSync(path.join(findInputDir(), name), buf);
  return name;
}

function buildWorkflow(cfg, prompt, neg, [w, h], n, refFile) {
  // Z-Image family (REDZ): UNETLoader + CLIPLoader(lumina2) + VAELoader + AuraFlow shift
  if (cfg.kind === 'zimage') {
    if (refFile) throw new Error('Z-Image models do not support reference images / IPAdapter consistency; pick a checkpoint-based model instead (e.g. sdxl-base)');
    const seed = Math.floor(Math.random() * 2 ** 32);
    const wf = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: cfg.diffusion, weight_dtype: 'default' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: cfg.text_encoder, type: cfg.clip_type || 'lumina2', weight_dtype: 'default' } },
      '15': { class_type: 'VAELoader', inputs: { vae_name: cfg.vae } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: cfg.positive ? cfg.positive + ', ' + prompt : prompt, clip: ['2', 0] } },
      '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      '6': { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: n } },
      '7': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: cfg.auraflow_shift ?? 3.0 } },
      '3': { class_type: 'KSampler', inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler || 'res_multistep', scheduler: cfg.scheduler || 'simple', denoise: 1, model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['15', 0] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-bridge', images: ['8', 0] } },
    };
    return wf;
  }
  const seed = Math.floor(Math.random() * 2 ** 32);
  const wf = {
    '3': { class_type: 'KSampler', inputs: { seed, steps: cfg.steps, cfg: cfg.cfg, sampler_name: cfg.sampler, scheduler: cfg.scheduler, denoise: 1, model: refFile ? ['13', 0] : ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: cfg.checkpoint } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: w, height: h, batch_size: n } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: cfg.positive ? cfg.positive + ', ' + prompt : prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: cfg.negative + ', ' + (neg || '') + (refFile && cfg.ipadapter_neg_override ? ', ' + cfg.ipadapter_neg_override : ''), clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'dsh-bridge', images: ['8', 0] } },
  };
  if (refFile) {
    wf['10'] = { class_type: 'LoadImage', inputs: { image: refFile } };
    wf['11'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: cfg.clip_vision || 'clip_vision_h.safetensors' } };
    wf['12'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: cfg.ipadapter || 'ip-adapter-plus_sdxl_vit-h.safetensors' } };
    // NoobAI style finetune (vahlok-alunmid) 需要 448x448 CLIP vision patch + size-aware apply 节点
    let clipRef = ['11', 0];
    if (cfg.extend_clip_vision) {
      wf['14'] = { class_type: 'EXTEND_CLIP_VISION_INPUT_SIZE', inputs: { clip_vision: ['11', 0], target_size: 448 } };
      clipRef = ['14', 0];
    }
    wf['13'] = { class_type: cfg.extend_clip_vision ? 'IPAdapterAdvancedSizeAware' : 'IPAdapterAdvanced', inputs: { model: ['4', 0], ipadapter: ['12', 0], image: ['10', 0], weight: cfg.ipadapter_weight || 0.8, weight_type: cfg.ipadapter_weight_type || 'linear', combine_embeds: 'concat', start_at: cfg.ipadapter_start_at || 0, end_at: cfg.ipadapter_end_at ?? 1, embeds_scaling: cfg.ipadapter_embeds_scaling || 'V only', clip_vision: clipRef } };
  }
  return wf;
}

async function comfyQueue(wf) {
  const res = await fetch(`${COMFY}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: wf, client_id: 'dsh-bridge' }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('comfy queue failed: ' + JSON.stringify(j).slice(0, 400));
  return j.prompt_id;
}

async function comfyWait(pid, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${COMFY}/history/${pid}`);
    const j = await res.json();
    if (j[pid] && j[pid].outputs) {
      const outs = j[pid].outputs;
      const node9 = outs['9'];
      if (node9 && node9.images && node9.images.length) return node9.images;
      const any = Object.values(outs).find((o) => o.images && o.images.length);
      if (any) return any.images;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('comfy generation timeout');
}

async function comfyView(filename, subfolder, type) {
  const u = `${COMFY}/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder || '')}&type=${type || 'output'}`;
  const res = await fetch(u);
  if (!res.ok) throw new Error('view failed: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// 模型文件是否在本机 ComfyUI models 目录存在（SDXL→checkpoints；Z-Image→diffusion_models）
function modelFileAvailable(m) {
  if (!m) return false;
  const base = process.env.COMFYUI_MODELS || (() => {
    const root = comfyRoot();
    for (const c of [path.join(root, 'models'), path.join(root, 'ComfyUI', 'models')]) {
      try { if (fs.existsSync(c)) return c; } catch {}
    }
    return path.join(root, 'models');
  })();
  const file = m.kind === 'zimage' ? path.join(base, 'diffusion_models', m.diffusion) : path.join(base, 'checkpoints', m.checkpoint);
  try { return fs.existsSync(file); } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const all = loadModels();
      let avail = all.filter(modelFileAvailable);
      if (!avail.length) avail = all; // 探测异常时兜底全量，避免面板空列表
      const models = avail.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'comfyui' }));
      return json(res, 200, { object: 'list', data: models });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/images/generations' || url.pathname === '/images/generations' || url.pathname === '/v1/images/edits' || url.pathname === '/images/edits')) {
      let raw;
      {
        // 收集原始字节（绝不能 raw += c 拼字符串：multipart 二进制会被 UTF-8 解码污染成 U+FFFD）
        const chunks = [];
        for await (const c of req) chunks.push(c);
        raw = Buffer.concat(chunks);
      }
      const ct = req.headers['content-type'] || '';
      let body;
      if (ct.includes('multipart/form-data')) {
        // dsh-imagegen 1.4.0+ 图生图走 multipart 表单（image/prompt/model/size...）
        // 用 Node 内置 Response.formData() 解析，零依赖；File 值转 data URL。
        const form = await new Response(raw, { headers: { 'content-type': ct } }).formData();
        body = {};
        for (const [k, v] of form.entries()) {
          body[k] = typeof v === 'string' ? v : `data:${v.type || 'image/png'};base64,${Buffer.from(await v.arrayBuffer()).toString('base64')}`;
        }
      } else {
        body = JSON.parse(raw.toString('utf8') || '{}');
      }
      if (Array.isArray(body.image)) body.image = body.image[0];
      const models = loadModels();
      let cfg = models.find((m) => m.id === body.model) || models[0];
      if (body.ipadapter_weight !== undefined && body.ipadapter_weight !== null) {
        cfg = { ...cfg, ipadapter_weight: Number(body.ipadapter_weight) };
      }
      if (body.ipadapter !== undefined && body.ipadapter !== null) {
        cfg = { ...cfg, ipadapter: String(body.ipadapter) };
      }
      if (body.clip_vision !== undefined && body.clip_vision !== null) {
        cfg = { ...cfg, clip_vision: String(body.clip_vision) };
      }
      const [w, h] = mapSize(body.size || body.image_size);
      const n = Math.min(Math.max(Number(body.n || body.batch_size || 1), 1), 4);
      const refFile = body.image ? saveRefImage(body.image) : null;
      if (refFile) console.log('[bridge] ref image saved: ' + refFile + ' (ipadapter weight=' + (cfg.ipadapter_weight || 0.8) + ')');
      const wf = buildWorkflow(cfg, body.prompt || '', body.negative_prompt || '', [w, h], n, refFile);
      const pid = await comfyQueue(wf);
      const images = await comfyWait(pid);
      const data = [];
      for (const img of images) {
        const buf = await comfyView(img.filename, img.subfolder, img.type);
        data.push({ b64_json: buf.toString('base64'), revised_prompt: null });
      }
      return json(res, 200, { created: Math.floor(Date.now() / 1000), data });
    }
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    return json(res, 404, { error: { message: 'not found: ' + url.pathname, type: 'not_found' } });
  } catch (e) {
    console.error('[bridge] error:', e.message);
    return json(res, 500, { error: { message: e.message, type: 'bridge_error' } });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] openai-bridge listening on http://127.0.0.1:${PORT} -> ${COMFY}`);
  console.log(`[bridge] models: ${loadModels().map((m) => m.id + '=' + m.checkpoint).join(', ')}`);
});
