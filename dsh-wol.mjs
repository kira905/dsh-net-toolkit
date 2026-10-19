#!/usr/bin/env node
/**
 * dsh-wol.mjs —— Wake-on-LAN 魔术包发送器 + 唤醒结果观测（只读，不改任何配置）
 *
 * 用途：从本机向局域网内目标机发 WOL 魔术包，并自动观测目标机是否被唤醒。
 * 零依赖，跨机通用（Windows / Linux / macOS 都能跑；Node.js >= 18）。
 *
 * 用法：
 *   node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --dry-run   # 只探测状态，不发包
 *   node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF             # 发包 + 等唤醒结果
 *   node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --no-watch  # 发完包立刻退出
 *   node dsh-wol.mjs --ip 203.0.113.10 --mac AA-BB-CC-DD-EE-FF --json
 *
 * 退出码：0=已确认唤醒 / 3=发完包但未观测到唤醒 / 4=发包前目标已在线 / 2=参数或环境错误
 */
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

// ---- 默认目标：无（必须显式传 --ip / --mac；仓里不保存任何真实内网值）----
const DEFAULTS = {
  mac: '',
  ip: '',
  probePort: 22, // 探活端口：关机=不通，开机=通（ssh / http 等常见服务均可）
  ports: [9, 7],
  rounds: 3,
  watchSeconds: 90,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS, dryRun: false, watch: true, json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--mac': out.mac = next(); break;
      case '--ip': out.ip = next(); break;
      case '--probe-port': out.probePort = Number(next()); break;
      case '--port': out.ports = [Number(next())]; break;
      case '--rounds': out.rounds = Number(next()); break;
      case '--watch': out.watchSeconds = Number(next()); break;
      case '--local': out.local = next(); break;
      case '--broadcast': out.broadcast = next(); break;
      case '--dry-run': out.dryRun = true; break;
      case '--force': out.force = true; break;
      case '--no-watch': out.watch = false; break;
      case '--json': out.json = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (a.startsWith('--')) { process.stderr.write(`unknown arg: ${a}\n`); out.bad = true; }
    }
  }
  return out;
}

function usage() {
  process.stdout.write(
    'dsh-wol.mjs —— 发 WOL 魔术包并观测唤醒结果（只读）\n' +
    '  --mac <MAC>       目标网卡 MAC（必填，例 AA-BB-CC-DD-EE-FF）\n' +
    '  --ip <IP>        目标 IP（必填，例 203.0.113.10）\n' +
    '  --port <N>        UDP 端口（默认先发 9 再发 7）\n' +
    '  --rounds <N>      发包轮数（默认 3，每轮广播+单播各一次）\n' +
    '  --watch <秒>      发包后观测时长（默认 90 秒）\n' +
    '  --local <IP>      指定本机源地址（多网卡时手动选链路）\n' +
    '  --broadcast <IP>  指定广播地址（默认按 /24 推导）\n' +
    '  --probe-port <N>  探活端口（默认 22）\n' +
    '  --dry-run         只探活，不发包\n' +
    '  --force           目标已在线也照发（验证发送链路用）\n' +
    '  --no-watch        发完即退\n' +
    '  --json            输出 JSON\n'
  );
}

function macToBytes(mac) {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`MAC 格式不对: ${mac}`);
  const b = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function magicPacket(macBytes) {
  const p = Buffer.alloc(102, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(p, 6 + i * 6);
  return p;
}

function probe(ip, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, ip); } catch { finish(false); }
  });
}

function subnetBroadcast(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
  return `${p[0]}.${p[1]}.${p[2]}.255`;
}

function localAddressFor(targetIp) {
  const prefix = targetIp.split('.').slice(0, 3).join('.');
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix + '.')) return a.address;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendPackets(opts, packet) {
  const targets = [];
  const bcast = opts.broadcast || subnetBroadcast(opts.ip);
  if (bcast) targets.push(bcast);
  if (targets.length === 0 || !targets.includes('255.255.255.255')) targets.push('255.255.255.255');
  // 单播也算：部分网卡在 S5 只认定向魔术包
  targets.push(opts.ip);

  const local = opts.local || localAddressFor(opts.ip);
  const results = [];
  const sock = dgram.createSocket('udp4');
  await new Promise((res) => {
    if (local) sock.bind(0, local, () => res());
    else sock.bind(() => res());
  });
  sock.setBroadcast(true); // Windows 上必须先 bind 才能设广播，否则 EBADF
  const bound = (() => { try { return sock.address(); } catch { return null; } })();

  for (let r = 0; r < opts.rounds; r++) {
    for (const t of targets) {
      for (const port of opts.ports) {
        await new Promise((res) => {
          sock.send(packet, 0, packet.length, port, t, (err) => {
            results.push({ round: r + 1, target: t, port, ok: !err, error: err ? err.message : null });
            res();
          });
        });
      }
    }
    if (r < opts.rounds - 1) await sleep(300);
  }
  sock.close();
  return { results, targets, local: bound && bound.address ? bound.address : local || null };
}

async function waitForWake(opts) {
  const deadline = Date.now() + opts.watchSeconds * 1000;
  const started = Date.now();
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    if (await probe(opts.ip, opts.probePort, 1500)) {
      return { woken: true, seconds: Math.round((Date.now() - started) / 1000), tries };
    }
    await sleep(3000);
  }
  return { woken: false, seconds: opts.watchSeconds, tries };
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.help && !opts.bad && (!opts.mac || !opts.ip)) {
  process.stderr.write('[错误] --mac 与 --ip 都是必填项（发布版不内置任何默认目标）。\n');
  usage();
  process.exitCode = 2;
} else if (opts.help) { usage(); process.exitCode = 0; }
else if (opts.bad) { process.exitCode = 2; }
else {
  try {
    const macBytes = macToBytes(opts.mac);
    const packet = magicPacket(macBytes);
    const before = await probe(opts.ip, opts.probePort);
    const report = {
      mac: opts.mac,
      ip: opts.ip,
      probePort: opts.probePort,
      onlineBefore: before,
      packets: null,
      wake: null,
      verdict: null,
    };

    if (before && !opts.force) {
      report.verdict = 'already-online';
      if (!opts.json) process.stdout.write(`[前置] ${opts.ip}:${opts.probePort} 已在线 —— 目标机现在是开着的，WOL 实测请先关机/休眠再跑。\n`);
    } else if (opts.dryRun) {
      report.verdict = 'dry-run';
      if (!opts.json) process.stdout.write(`[前置] ${opts.ip}:${opts.probePort} 探测无响应（离线）—— 可以发包。--dry-run 未发包。\n`);
    } else {
      const sent = await sendPackets(opts, packet);
      report.packets = sent;
      const okCount = sent.results.filter((x) => x.ok).length;
      if (!opts.json) {
        process.stdout.write(
          `[发包] MAC ${opts.mac} → ${sent.targets.join(', ')} : ${opts.ports.join('/')} 端口，${opts.rounds} 轮，成功 ${okCount}/${sent.results.length}` +
            (sent.local ? `（源 ${sent.local}）` : '') + '\n'
        );
      }
      if (okCount === 0) {
        report.verdict = 'send-failed';
        if (!opts.json) process.stdout.write('[结果] 一个包都没发出去 —— 多半是网络/权限问题，不是目标机不支持 WOL。\n');
      } else if (!opts.watch) {
        report.verdict = 'sent-no-watch';
        if (!opts.json) process.stdout.write(`[结果] 已发包（未等待观测）。请自行看目标机是否亮机，或再跑 --dry-run 探活 ${opts.ip}:${opts.probePort}。\n`);
      } else {
        if (!opts.json) process.stdout.write(`[观测] 等最多 ${opts.watchSeconds} 秒看目标机是否起来…\n`);
        const w = await waitForWake(opts);
        report.wake = w;
        report.verdict = w.woken ? 'woken' : 'no-wake';
        if (!opts.json) {
          process.stdout.write(
            w.woken
              ? `[结果] ✅ 唤醒成功：${w.seconds} 秒后 ${opts.ip}:${opts.probePort} 通了。\n`
              : `[结果] ❌ ${opts.watchSeconds} 秒内没起来（探测 ${w.tries} 次）。往下查目标机侧设置：BIOS 的 ErP/网络唤醒、Windows 网卡电源管理、快速启动。\n`
          );
        }
      }
    }

    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exitCode = report.verdict === 'woken' ? 0 : report.verdict === 'already-online' ? 4 : report.verdict === 'no-wake' || report.verdict === 'send-failed' ? 3 : 0;
  } catch (err) {
    process.stderr.write(`[错误] ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 2;
  }
}
