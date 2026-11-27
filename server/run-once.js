// King Sniper "run once": wakes up, catches up on every bar that closed since the last run, sends the
// Discord alerts, saves its state and exits. Meant for a scheduler (GitHub Actions), so no computer or
// terminal has to stay on. No npm packages needed.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import '../public/shared/market.js';
import '../public/shared/engine.js';
import { createAlerts } from './alerts.js';
import { ROOT, loadEnv, loadConfig, resolveSymbols } from './config.js';

const KS = globalThis.KS;
const log = (m) => console.log(new Date().toISOString(), m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

loadEnv();
const config = loadConfig();
const webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
if (!/^https?:\/\//.test(webhookUrl)) { console.error('DISCORD_WEBHOOK_URL is not set. In GitHub: Settings > Secrets and variables > Actions > New repository secret.'); process.exit(1); }
// runs start a few minutes after the bar closes, so allow a longer delay than the always-on server does
config.maxAlertAgeSeconds = config.cloudMaxAlertAgeSeconds ?? 900;

const BUDGET_MS = Number(process.env.KS_RUN_BUDGET_SECONDS || 420) * 1000; // stop waiting after this long
const stateFile = process.env.KS_STATE || join(ROOT, 'data', 'state.json');
const warnedFile = join(dirname(stateFile), 'warned.json');
const api = KS.createApi({ url: process.env.HL_API_URL || undefined });

const markets = await resolveSymbols(api, config.symbols);
if (markets.unchecked) log('Could not check the market list (' + markets.error + '), using symbols.txt as typed.');
config.symbols = markets.ok;
if (!config.symbols.length) { console.error('None of the markets in symbols.txt exist on Hyperliquid.'); process.exit(1); }

const alerts = createAlerts({ config, api, webhookUrl, stateFile, log });
const startedAt = Date.now();
log(`Watching ${alerts.coins.join(', ')} on ${config.timeframes.join(', ')}`);

// safety net: if something hangs, still save the progress and stop (a killed job would lose its state)
setTimeout(() => { try { alerts.saveNow(); } catch {} log('[timeout] stopped early, progress saved'); process.exit(0); }, BUDGET_MS + 180000).unref();

// 1. anything left over from the last run (Discord was down, for example)
alerts.sender.flush();

// 2. warn once about names Hyperliquid does not know (not on every run)
if (markets.bad.length) {
  let warned = [];
  try { warned = JSON.parse(readFileSync(warnedFile, 'utf8')); } catch { /* first time */ }
  const fresh = markets.bad.filter((b) => !warned.includes(b));
  log(`WARNING: not a Hyperliquid perpetual, skipped: ${markets.bad.join(', ')}`);
  if (fresh.length) {
    alerts.sender.send([{ color: 0xf59e0b, title: '⚠️ Some markets were skipped', description: `Not a Hyperliquid perpetual: ${fresh.join(', ')}\nCheck the spelling in symbols.txt (for example DOGEUSDC.P).`, timestamp: new Date().toISOString() }]);
  }
}
mkdirSync(dirname(warnedFile), { recursive: true });
writeFileSync(warnedFile, JSON.stringify(markets.bad));

// 3. process every closed bar until all charts are up to date
while (!alerts.isCaughtUp() && Date.now() - startedAt < BUDGET_MS) {
  await alerts.tick();
  if (!alerts.isCaughtUp()) await sleep(1000);
}
const behind = [...alerts.streams.values()].filter((s) => !s.engine || Date.now() >= KS.bucketEnd(s.nextTime, s.tf) + 3000);
if (behind.length) log(`[warning] not finished: ${behind.map((s) => s.key + (s.error ? ' (' + s.error + ')' : '')).join(', ')}. The next run continues from here.`);

// 4. TP / stop touches inside the bar that is still forming
await alerts.liveScan();

// 5. markets that were set up (or refreshed) in this run: list them and let their open trades be reported
const fresh = [...alerts.streams.values()].filter((s) => s.fresh);
if (fresh.length) {
  const open = alerts.announceOpen((s) => s.fresh);
  const first = !alerts.hadSavedState;
  const names = [...new Set(fresh.map((s) => KS.symbolOf(s.coin)))];
  if (config.startupMessage !== false) {
    alerts.sender.send([{
      color: 0x3b82f6,
      title: first ? '📡 King Sniper alerts are online' : '📡 King Sniper is watching new or refreshed markets',
      description: `Markets: ${names.join(', ')}\nTimeframes: ${config.timeframes.join(', ')}\n\n**Open simulated trades**\n${open.join('\n').slice(0, 3000) || 'none'}`,
      timestamp: new Date().toISOString(),
    }]);
  }
}

// 6. deliver, save, exit
await Promise.race([alerts.sender.flush(), sleep(120000)]); // anything still undelivered stays in the state file for the next run
alerts.saveNow();
log(`Done in ${Math.round((Date.now() - startedAt) / 1000)}s. ${alerts.sender.queue.length} message(s) waiting for the next run.`);
process.exit(0);
