// Runs the indicator on every watched market and turns its events into Discord alerts.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import '../public/shared/market.js';
import '../public/shared/engine.js';
import { embedFor, createSender } from './discord.js';
const KS = globalThis.KS;

const GRACE_MS = 3000; // wait after a bar closes so Hyperliquid has the final candle

export function createAlerts({ config, api, webhookUrl, stateFile, log = console.log, now = () => Date.now() }) {
  const settings = config.settings || {};
  const coins = config.symbols.map(KS.coinOf);
  const hash = createHash('sha1').update(JSON.stringify([KS.effective(settings, '1h'), settings])).digest('hex').slice(0, 12);

  let disk = { streams: {}, sent: [], queue: [], recent: [] };
  try { disk = { ...disk, ...KS.loadState(readFileSync(stateFile, 'utf8')) }; } catch (e) { if (e.code !== 'ENOENT') log('[state] unreadable, starting fresh: ' + e.message); }
  const sent = new Set(disk.sent);
  const recent = disk.recent;
  const streams = new Map();

  let saveTimer = null;
  function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    const out = { streams: { ...disk.streams }, sent: [...sent].slice(-4000), queue: sender.queue, recent: recent.slice(-100) };
    for (const [key, s] of streams) if (s.engine) out.streams[key] = { hash, nextTime: s.nextTime, engine: s.engine.state };
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile + '.tmp', KS.saveState(out));
    renameSync(stateFile + '.tmp', stateFile);
  }
  const save = () => { saveTimer ||= setTimeout(() => { try { saveNow(); } catch (e) { log('[state] save failed: ' + e.message); } }, 500); };
  // an entry that expired before it could be delivered counts as never announced
  const sender = createSender({ webhookUrl, queue: disk.queue, onChange: save, onExpire: (trade) => sent.delete(`${trade}|ENTRY`), log, now });

  for (const coin of coins) for (const tf of config.timeframes) {
    streams.set(`${coin}|${tf}`, { key: `${coin}|${tf}`, coin, tf, engine: null, nextTime: 0, retryAt: 0, busy: false, error: '' });
  }

  function emit(s, events, live) {
    const t = now();
    const maxAge = (config.maxAlertAgeSeconds ?? 180) * 1000;
    const items = [];
    for (const e of events) {
      const isEntry = e.type === 'BUY' || e.type === 'SELL';
      const slot = isEntry ? 'ENTRY' : e.type === 'SL' || e.type === 'TRAIL' ? 'STOP' : e.type;
      const trade = `${s.key}|${e.tradeId}`;
      const id = `${trade}|${slot}`;
      if (sent.has(id)) continue;
      // exits are only reported for trades that were announced
      if (!isEntry && !sent.has(`${trade}|ENTRY`)) continue;
      // After the stop or TP3 there is nothing more to report, except one case: TP3 was announced
      // live, but at bar close the indicator (which checks the stop first) books a stop instead.
      let note = '';
      if (!isEntry && sent.has(`${trade}|STOP`)) continue;
      if (!isEntry && sent.has(`${trade}|TP3`)) {
        if (live || slot !== 'STOP') continue;
        note = 'Correction: this bar touched both TP3 and the stop. The indicator counts the stop first, so its record for this trade uses this result.';
      }
      const deadline = (live ? t : KS.bucketEnd(e.barTime, s.tf)) + maxAge;
      const late = t > deadline;
      if (late && isEntry) { log(`[skip] old ${e.type} ${s.key}`); continue; }
      sent.add(id);
      const symbol = KS.symbolOf(s.coin);
      const embed = embedFor({ event: { ...e, sentAt: t }, symbol, tf: s.tf, mode: s.engine.cfg.mode, late });
      if (note) embed.description = note;
      items.push({ embed, meta: { trade, entry: isEntry, deadline } });
      recent.push({ at: t, symbol, tf: s.tf, type: e.type, flip: !!e.flip, dir: e.dir, price: e.price, entry: e.entry, late });
      if (recent.length > 100) recent.shift();
      log(`[alert] ${e.type} ${symbol} ${s.tf} @ ${KS.fmtPrice(e.price)}`);
    }
    if (items.length) { save(); sender.send(items.map((i) => i.embed), items.map((i) => i.meta)); }
  }

  // Open trades listed in the start-up message count as announced, so their TP / SL get reported.
  function announceOpen() {
    const lines = [];
    for (const s of streams.values()) {
      const st = s.engine?.stats();
      if (!st?.dir) continue;
      sent.add(`${s.key}|${st.tradeId}|ENTRY`);
      lines.push(`${KS.symbolOf(s.coin)} ${s.tf}: ${st.position} from ${KS.fmtPrice(st.entry)}, stop ${KS.fmtPrice(st.sl)}`);
    }
    save();
    return lines;
  }

  async function init(s) {
    const t = now();
    const saved = disk.streams[s.key];
    const base = KS.TIMEFRAMES[s.tf].base;
    if (saved && saved.hash === hash && t - saved.nextTime < KS.BASE_MS[base] * 4000) {
      s.engine = KS.createEngine(settings, s.tf, { state: saved.engine });
      s.nextTime = saved.nextTime;
      return;
    }
    const { engine, bars } = await KS.bootstrap(api, s.coin, s.tf, settings, { count: config.historyBars, now: t });
    const closed = bars.filter((b) => {
      const end = KS.bucketEnd(b.t, s.tf);
      return end + GRACE_MS <= t && !(b.last < end - KS.BASE_MS[base] && t < end + 30000);
    });
    if (!closed.length) throw new Error('no closed candles returned');
    for (const b of closed) engine.step(b);
    s.engine = engine;
    s.nextTime = KS.bucketEnd(closed[closed.length - 1].t, s.tf);
  }

  // Process every bar that has closed since the last run.
  async function catchUp(s) {
    const t = now();
    const bars = await api.history(s.coin, s.tf, Math.min(KS.MAX_CANDLES, Math.ceil((t - s.nextTime) / KS.BASE_MS[KS.TIMEFRAMES[s.tf].base]) + 2), t);
    let done = 0;
    for (const b of bars) {
      if (b.t < s.nextTime) continue;
      const end = KS.bucketEnd(b.t, s.tf);
      if (end + GRACE_MS > t) break;
      const baseMs = KS.BASE_MS[KS.TIMEFRAMES[s.tf].base];
      if (b.last < end - baseMs && t < end + 30000) break; // last piece of the bar not published yet
      if (!s.engine.htfReady(b.t)) {
        await s.engine.syncHtf(api, s.coin, t);
        if (!s.engine.htfReady(b.t) && t < end + 60000) break; // wait for the higher-timeframe candle
      }
      const row = s.engine.step(b);
      s.nextTime = end;
      done++;
      emit(s, row.events, false);
    }
    if (done) save();
    return done;
  }

  async function runStream(s) {
    if (s.busy || now() < s.retryAt) return;
    if (s.engine && now() < KS.bucketEnd(s.nextTime, s.tf) + GRACE_MS) return;
    s.busy = true;
    try {
      if (!s.engine) { await init(s); save(); log(`[ready] ${s.key}`); await catchUp(s); }
      else if (!(await catchUp(s))) s.retryAt = now() + 5000;
      s.error = '';
    } catch (e) {
      s.error = e.message;
      s.retryAt = now() + 15000;
      log(`[error] ${s.key}: ${e.message}`);
    } finally { s.busy = false; }
  }
  const tick = () => Promise.all([...streams.values()].map(runStream));

  // Live 1m candles from the websocket: alert TP / SL as soon as price touches them.
  function onLiveCandle(c) {
    if (config.tpSlAlerts === 'close') return;
    const bar = KS.parseCandle(c);
    for (const s of streams.values()) {
      if (s.coin !== c.s || !s.engine || s.busy) continue;
      // only when this minute belongs to the bar currently forming
      if (bar.t < s.nextTime || bar.t >= KS.bucketEnd(s.nextTime, s.tf)) continue;
      const events = s.engine.preview(bar);
      if (events.length) emit(s, events, true);
    }
  }

  function snapshot() {
    return [...streams.values()].map((s) => {
      const st = s.engine?.stats();
      return { symbol: KS.symbolOf(s.coin), tf: s.tf, ready: !!s.engine, error: s.error, position: st?.position, stage: st?.stage, entry: st?.dir ? st.entry : null, sl: st?.dir ? st.sl : null };
    });
  }

  return { tick, onLiveCandle, snapshot, announceOpen, saveNow, sender, streams, recent, coins };
}
