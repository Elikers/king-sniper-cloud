// A fake Hyperliquid (REST + websocket) and fake Discord webhook, for offline tests.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import '../public/shared/market.js';
const KS = globalThis.KS;

const hash = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x); };
const BASE = { BTC: 96000, ETH: 3300, SOL: 190, HYPE: 38, ZEC: 520 };
export function priceAt(coin, t) {
  const m = t / 60000, b = BASE[coin] || 100;
  return b * (1 + 0.05 * Math.sin(m / 9000) + 0.022 * Math.sin(m / 1300) + 0.009 * Math.sin(m / 211) + 0.003 * Math.sin(m / 31) + 0.0012 * Math.sin(m / 3.7) + 0.0009 * (hash(Math.floor(m)) - 0.5));
}
export function candle(coin, interval, t, now = Date.now()) {
  const ms = KS.BASE_MS[interval], end = Math.min(t + ms, now);
  const o = priceAt(coin, t), c = priceAt(coin, end);
  let h = Math.max(o, c), l = Math.min(o, c);
  for (let i = 1; i < 12; i++) { const p = priceAt(coin, t + ((end - t) * i) / 12); h = Math.max(h, p); l = Math.min(l, p); }
  const w = Math.abs(c - o) * 0.2 + o * 0.0004 * Math.sqrt(ms / 60000) * hash(t / 1000 + 7);
  const v = (20 + 80 * hash(t / 1000 + 3) + (Math.abs(c - o) / o) * 40000) * (ms / 60000) ** 0.7;
  return { t, T: t + ms - 1, s: coin, i: interval, o: String(o), c: String(c), h: String(h + w * hash(t / 997)), l: String(l - w * hash(t / 991)), v: String(v), n: 10 };
}
export function info(body, now = Date.now()) {
  if (body.type === 'candleSnapshot') {
    const { coin, interval, startTime, endTime } = body.req, ms = KS.BASE_MS[interval], out = [];
    const last = Math.floor(Math.min(endTime, now) / ms) * ms;
    let t = Math.max(Math.ceil(startTime / ms) * ms, last - 4999 * ms);
    for (; t <= last; t += ms) out.push(candle(coin, interval, t, now));
    return out;
  }
  if (body.type === 'metaAndAssetCtxs') {
    const names = [...Object.keys(BASE), 'DOGE'];
    return [{ universe: names.map((name) => ({ name })) }, names.map((n) => ({ midPx: String(priceAt(n, now)), markPx: String(priceAt(n, now)), prevDayPx: String(priceAt(n, now - 86400000)) }))];
  }
  return null;
}

// minimal websocket server (text frames only)
const frame = (text) => {
  const d = Buffer.from(text);
  const head = d.length < 126 ? Buffer.from([0x81, d.length]) : Buffer.from([0x81, 126, d.length >> 8, d.length & 255]);
  return Buffer.concat([head, d]);
};
export function startMock({ webhook = () => ({ status: 200 }) } = {}) {
  const sockets = new Set(), messages = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (req.url.startsWith('/webhook')) {
        const r = webhook(body);
        if (r.status === 200) messages.push(body);
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(r.body || {}));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info(body)));
    });
  });
  server.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const subs = new Map();
    sockets.add(sock);
    sock.on('data', (buf) => {
      for (let p = 0; p + 6 <= buf.length;) {
        const op = buf[p] & 15; let len = buf[p + 1] & 127, off = p + 2;
        if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
        const mask = buf.subarray(off, off + 4); off += 4;
        const data = Buffer.from(buf.subarray(off, off + len)).map((b, i) => b ^ mask[i % 4]);
        p = off + len;
        if (op !== 1) continue;
        const m = JSON.parse(data.toString());
        if (m.method === 'subscribe') subs.set(JSON.stringify(m.subscription), m.subscription);
        if (m.method === 'unsubscribe') subs.delete(JSON.stringify(m.subscription));
      }
    });
    const timer = setInterval(() => {
      for (const s of subs.values()) if (s.type === 'candle') {
        const ms = KS.BASE_MS[s.interval], now = Date.now();
        sock.write(frame(JSON.stringify({ channel: 'candle', data: candle(s.coin, s.interval, Math.floor(now / ms) * ms, now) })));
      }
    }, 500);
    const end = () => { clearInterval(timer); sockets.delete(sock); sock.destroy(); };
    sock.on('close', end); sock.on('error', end); sock.on('end', end);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({
      port, messages, url: `http://127.0.0.1:${port}/info`, wsUrl: `ws://127.0.0.1:${port}/ws`, webhookUrl: `http://127.0.0.1:${port}/webhook`,
      close: () => { for (const s of sockets) s.destroy(); server.close(); server.closeAllConnections(); },
    });
  }));
}
