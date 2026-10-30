// 只读：连独立 Chrome(9222) 抓 25 秒网络请求 + 控制台报错，对比改动前后的轮询频率
import { cliGuard } from './lib/cli-args.mjs';

const PORT = Number(process.env.CDP_PORT || 9222);
const SPEC = {
  cmd: 'dsh-cdp-net-capture',
  summary: '只读网络取证：连独立 Chrome（9222）抓一段时间内的网络请求与控制台报错，用来对比改动前后的轮询频率。',
  usage: 'dsh-cdp-net-capture [url] [秒数] [--click <选择器>] [--settle 12] [--emulate-visible]',
  flags: [
    { name: '--click', arg: 'CSS选择器', desc: '观测窗口开始前先在页面里点一下这个元素' },
    { name: '--settle', arg: '秒', desc: '点击后等多少秒再开始统计，默认 12' },
    { name: '--emulate-visible', desc: '把页面当成前台可见（防 visibilityState=hidden 改变客户端连接行为）' },
  ],
  positional: [
    { name: '[url]', desc: '要观测的页面，默认本机 3080 首页' },
    { name: '[秒数]', desc: '观测窗口，默认 25 秒' },
  ],
  env: [{ name: 'CDP_PORT', desc: 'Chrome 调试端口，默认 9222' }],
  writes: '不写盘、不改配置：只读页面网络与控制台，结果打到 stdout。会打开 / 点击目标页（该页自身的网络行为照常发生）。',
  exits: '0 成功 · 1 连不上 Chrome 或页面出错 · 2 参数错误',
  examples: ['dsh-cdp-net-capture', 'dsh-cdp-net-capture http://127.0.0.1:3080/ 10'],
};
const argv = cliGuard(SPEC);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const URL_TO_OPEN = positional[0] || 'http://127.0.0.1:3080/';
const SECONDS = Number(positional[1] || 25);
// Only count requests that hit the target port. The private build hard-coded 3080,
// which silently turns every reading into 0 when the app listens elsewhere.
const TARGET_PORT = (() => {
  try {
    const u = new URL(URL_TO_OPEN);
    return u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch { return ''; }
})();
// Optional in-page click before the observation window: some states only exist
// after an interaction (e.g. a panel that subscribes to SSE once opened).
// Read-only in spirit — a plain DOM click, no test hooks in the page.
const CLICK_SELECTOR = flagValue('--click', '');
const SETTLE_SECONDS = Number(flagValue('--settle', 12));
// Treat the page as a focused, active one: a minimized/occluded window otherwise
// reports visibilityState=hidden, which changes what a visibility-gated client
// connects to. Recorded in the health line so the reading is never ambiguous.
const EMULATE_VISIBLE = argv.includes('--emulate-visible');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('timeout ' + method)); } }, 30000);
});

const counts = new Map();
const reqUrl = new Map();
const finished = new Set();
const failed = new Map();
const sockets = [];
const consoleErrs = [];
let total = 0;

await new Promise((res, rej) => {
  ws.addEventListener('open', res);
  ws.addEventListener('error', rej);
});

ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(ev.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (!m.method) return;
  if (m.method === 'Network.requestWillBeSent') {
    const url = m.params.request.url;
    if (!TARGET_PORT || !url.includes(':' + TARGET_PORT)) return;
    let p;
    try { p = new URL(url).pathname; } catch { p = url; }
    counts.set(p, (counts.get(p) || 0) + 1);
    reqUrl.set(m.params.requestId, p);
    total++;
  } else if (m.method === 'Network.loadingFinished') {
    finished.add(m.params.requestId);
  } else if (m.method === 'Network.loadingFailed') {
    const p = reqUrl.get(m.params.requestId);
    if (p) failed.set(p, (failed.get(p) || 0) + 1);
  } else if (m.method === 'Network.webSocketCreated') {
    sockets.push(m.params.url);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrs.push('[exception] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0]);
  } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleErrs.push(`[${m.params.type}] ` + String(txt).split('\n')[0].slice(0, 200));
  }
});

await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');
if (EMULATE_VISIBLE) { try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {} }
try { await send('Page.bringToFront'); } catch {}
await send('Page.navigate', { url: URL_TO_OPEN });
await new Promise((r) => setTimeout(r, SETTLE_SECONDS * 1000));
let clickResult = 'not-requested';
if (CLICK_SELECTOR !== '') {
  clickResult = 'missing';
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(CLICK_SELECTOR)}); if (el === null) return 'missing'; el.click(); return 'clicked'; })()`,
      returnByValue: true,
    });
    clickResult = r.result?.value ?? 'unknown';
    if (clickResult === 'clicked') break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
}
await new Promise((r) => setTimeout(r, SECONDS * 1000));

// 页面渲染健康度
let health = null;
try {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ title: document.title, visibility: document.visibilityState, hidden: document.hidden, rootChildren: (document.getElementById('root')||document.body).children.length, hasSidebar: !!document.querySelector('[class*=sidebar], aside'), textSample: (document.body.innerText||'').slice(0,120) })`,
    returnByValue: true,
  });
  health = r.result?.value;
} catch (e) { health = 'eval-failed: ' + e.message; }

if (CLICK_SELECTOR !== '') console.log(`点击：${CLICK_SELECTOR} -> ${clickResult}（点击后观测 ${SECONDS}s，导航后先等 ${SETTLE_SECONDS}s）`);
console.log(`观测 ${SECONDS}s ｜ 到目标端口 ${TARGET_PORT} 的请求总数 = ${total}`);
console.log('\n=== 轮询类端点（次数） ===');
const pollPaths = [...counts.entries()].filter(([p]) => /task-status|imagegen\/tasks|download-progress|task-board\/state/.test(p));
if (pollPaths.length === 0) console.log('  (无)');
pollPaths.sort((a, b) => b[1] - a[1]).forEach(([p, n]) => console.log(String(n).padStart(5), p));

console.log('\n=== 观测结束时仍未结束的请求（= 长连接/SSE） ===');
const open = [...reqUrl.entries()].filter(([rid]) => !finished.has(rid)).map(([, p]) => p);
const byPath = new Map();
for (const p of open) byPath.set(p, (byPath.get(p) || 0) + 1);
[...byPath.entries()].forEach(([p, n]) => console.log(String(n).padStart(5), p));

console.log('\n=== WebSocket ===');
sockets.forEach((s) => console.log(' ', s));

console.log('\n=== 控制台 error/warning（去重前 12 条） ===');
if (consoleErrs.length === 0) console.log('  (无)');
else {
  const uniq = [...new Set(consoleErrs)];
  uniq.slice(0, 12).forEach((s) => console.log(' ', s));
  console.log(`  … 共 ${consoleErrs.length} 条 / 去重 ${uniq.length} 条`);
}

console.log('\n=== 页面渲染健康度 ===');
console.log(' ', health);
ws.close();
