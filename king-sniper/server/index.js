// King Sniper server: serves the website and sends Discord alerts 24/7. No npm packages needed.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import '../public/shared/market.js';
import '../public/shared/engine.js';
import { createAlerts } from './alerts.js';
import { embedFor, createSender } from './discord.js';
import { ROOT, loadEnv, loadConfig, resolveSymbols } from './config.js';

const KS = globalThis.KS;
const PUBLIC = join(ROOT, 'public');

loadEnv();
const config = loadConfig();
const webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
const log = (m) => console.log(new Date().toISOString(), m);

if (process.argv.includes('--test-alert')) {
  const sender = createSender({ webhookUrl, log });
  if (!sender.status.configured) { console.error('Set DISCORD_WEBHOOK_URL in the .env file first.'); process.exit(1); }
  const sample = { type: 'BUY', dir: 1, price: 100, entry: 100, sl: 97.5, tp1: 101.25, tp2: 102.5, tp3: 103.75, conf: 88, score: 11, winRate: NaN, n: 0, qty: 0.2, notional: 20, barTime: Date.now() };
  const embed = embedFor({ event: sample, symbol: 'TEST (not a real signal)', tf: '15m', mode: 'connection test' });
  const timeout = setTimeout(() => { console.error('Could not reach Discord: ' + sender.status.lastError); process.exit(1); }, 40000);
  await sender.send([embed]);
  clearTimeout(timeout);
  if (sender.status.lastError || !sender.status.lastSentAt) { console.error('Test failed: ' + sender.status.lastError); process.exit(1); }
  console.log('Test alert sent. Check your Discord channel.');
  process.exit(0);
}

const api = KS.createApi({ url: process.env.HL_API_URL || undefined });
const markets = await resolveSymbols(api, config.symbols);
config.symbols = markets.ok;
if (markets.unchecked) log('Could not check the market list (' + markets.error + '), using symbols.txt as typed.');
if (markets.bad.length) log(`WARNING: not a Hyperliquid perpetual, skipped: ${markets.bad.join(', ')}`);
if (!config.symbols.length) { console.error('None of the markets in symbols.txt exist on Hyperliquid.'); process.exit(1); }
const alerts = createAlerts({ config, api, webhookUrl, stateFile: process.env.KS_STATE || join(ROOT, 'data', 'state.json'), log });
const startedAt = Date.now();
let wsUp = false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.pine': 'text/plain', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const reply = (code, type, body) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
  try {
    if (req.method !== 'GET') return reply(405, 'text/plain', 'Method not allowed');
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/api/status') {
      return reply(200, 'application/json', JSON.stringify({
        startedAt, websocket: wsUp, symbols: alerts.coins.map(KS.symbolOf), timeframes: config.timeframes, settings: config.settings || {},
        tpSlAlerts: config.tpSlAlerts || 'live', discord: alerts.sender.status, pending: alerts.sender.queue.length,
        streams: alerts.snapshot(), recent: alerts.recent.slice(-50).reverse(),
      }));
    }
    if (path === '/indicator.pine') return reply(200, 'text/plain', await readFile(join(ROOT, 'indicator', 'king_sniper_smart_filter.pine')));
    const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
    if (!file.startsWith(PUBLIC + sep) || !TYPES[extname(file)]) return reply(404, 'text/plain', 'Not found');
    return reply(200, TYPES[extname(file)], await readFile(file));
  } catch (e) {
    return reply(e.code === 'ENOENT' ? 404 : 500, 'text/plain', e.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
});

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => log(`Website: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Is the server already running?` : e.message); process.exit(1); });

log(`Watching ${alerts.coins.join(', ')} on ${config.timeframes.join(', ')}`);
if (!alerts.sender.status.configured) log('WARNING: DISCORD_WEBHOOK_URL is not set, no alerts will be sent.');
alerts.sender.flush();
if (markets.bad.length) alerts.sender.send([{ color: 0xf59e0b, title: '⚠️ Some markets were skipped', description: `Not a Hyperliquid perpetual: ${markets.bad.join(', ')}\nCheck the spelling in symbols.txt (for example DOGEUSDC.P).`, timestamp: new Date().toISOString() }]);

const stream = KS.createStream({
  url: process.env.HL_WS_URL || undefined,
  onStatus: (up) => { wsUp = up; log(up ? 'Live price feed connected' : 'Live price feed disconnected, retrying'); },
  onMessage: (m) => { if (m.channel === 'candle') for (const c of [].concat(m.data)) alerts.onLiveCandle(c); },
});
for (const coin of alerts.coins) stream.subscribe({ type: 'candle', coin, interval: '1m' });

let announced = false;
async function loop() {
  await alerts.tick();
  if (!announced && ([...alerts.streams.values()].every((s) => s.engine) || (Date.now() - startedAt > 600000 && [...alerts.streams.values()].some((s) => s.engine)))) {
    announced = true;
    const open = alerts.announceOpen(); // also lets their TP / SL be reported when the message is off
    if (config.startupMessage === false) return;
    alerts.sender.send([{ color: 0x3b82f6, title: '📡 King Sniper alerts are online', description: `Markets: ${alerts.coins.map(KS.symbolOf).join(', ')}\nTimeframes: ${config.timeframes.join(', ')}\n\n**Open simulated trades**\n${open.join('\n').slice(0, 3000) || 'none'}`, timestamp: new Date().toISOString() }]);
  }
}
const run = () => loop().catch((e) => log('loop error: ' + e.message));
run();
setInterval(run, 1000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { alerts.saveNow(); } catch {} process.exit(0); });
