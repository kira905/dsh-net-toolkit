// 零依赖 CDP 客户端：连本机 9222 端口上的 Chrome，在页面里执行 JS
// 需要 Node.js >= 22（用到全局 WebSocket）
// 用法:
//   node dsh-cdp.mjs list
//   node dsh-cdp.mjs eval "<JS 表达式>"
//   node dsh-cdp.mjs eval-file <含 JS 的文件路径>
//   node dsh-cdp.mjs nav <url>
import fs from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const mode = process.argv[2] || 'list';
const arg = process.argv[3] || '';

async function listTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  if (!r.ok) throw new Error('cdp list http ' + r.status);
  return await r.json();
}

function pickTarget(targets, prefer = '') {
  const pages = targets.filter((t) => t.type === 'page');
  if (!prefer) return pages[0];
  return pages.find((t) => (t.url || '').includes(prefer)) || pages[0];
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
          setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('cdp timeout ' + method)); } }, 60000);
        });
      },
      close() { ws.close(); },
    }));
    ws.addEventListener('error', (e) => reject(new Error('ws error')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  });
}

async function main() {
  const targets = await listTargets();
  if (mode === 'list') {
    console.log(JSON.stringify(targets.map((t) => ({ type: t.type, title: t.title, url: t.url, id: t.id })), null, 1));
    return;
  }
  const t = pickTarget(targets, process.env.CDP_MATCH || '');
  if (!t) throw new Error('no page target found');
  const cdp = await connect(t.webSocketDebuggerUrl);
  try {
    if (mode === 'nav') {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: arg });
      console.log(JSON.stringify({ navigated: arg, target: t.url }));
      return;
    }
    let expr = arg;
    if (mode === 'eval-file') expr = fs.readFileSync(arg, 'utf8');
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(async () => { ${mode === 'eval-file' || mode === 'eval' ? expr : 'return null;'} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      console.error('PAGE EXCEPTION:', JSON.stringify(r.exceptionDetails).slice(0, 1500));
      process.exitCode = 1;
      return;
    }
    const v = r.result?.value;
    const out = typeof v === 'string' ? v : JSON.stringify(v, null, 1);
    if (process.env.CDP_OUT) {
      fs.writeFileSync(process.env.CDP_OUT, out, 'utf8');
      console.log('written to', process.env.CDP_OUT, 'bytes', out.length);
    } else {
      console.log(out);
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => { console.error('CDP FAIL:', e.message); process.exitCode = 1; });
