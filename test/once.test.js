// Tests for the "run once" mode (GitHub Actions) and the market list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { startMock, info } from './mock.js';
import { createAlerts } from '../server/alerts.js';
import { parseSymbols, resolveSymbols } from '../server/config.js';
import '../public/shared/market.js';
const KS = globalThis.KS;
const quiet = () => {};

function makeApi(clock) {
  const api = {
    candles: async (coin, interval, start, end) => info({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }, clock.t).map(KS.parseCandle),
    history: async (coin, tf, count = 5000) => {
      const base = KS.TIMEFRAMES[tf].base;
      const bars = KS.aggregate(await api.candles(coin, base, clock.t - count * KS.BASE_MS[base], clock.t), tf);
      if (bars.length > 1 && bars[0].first !== bars[0].t && tf !== '1W' && tf !== '1M') bars.shift();
      return bars;
    },
  };
  return api;
}
// one "run" of run-once.js, in-process: new objects every time, only the state file survives
async function oneRun(webhookUrl, clock, stateFile, config) {
  const alerts = createAlerts({ config, api: makeApi(clock), webhookUrl, stateFile, log: quiet, now: () => clock.t });
  for (let i = 0; i < 30 && !alerts.isCaughtUp(); i++) await alerts.tick();
  await alerts.liveScan();
  await alerts.sender.flush();
  alerts.saveNow();
  return alerts;
}

test('symbols.txt lines: comments, commas, TradingView names', () => {
  assert.deepEqual(parseSymbols('BTCUSDC.P\n# nope\n doge # x\nHYPERLIQUID:kpepeusdc.p, SOL'), ['BTCUSDC.P', 'doge', 'HYPERLIQUID:kpepeusdc.p', 'SOL']);
});

test('market names are checked against Hyperliquid and spelled correctly', async () => {
  const api = { info: async () => ({ universe: [{ name: 'BTC' }, { name: 'kPEPE' }, { name: 'DOGE' }, { name: 'OLD', isDelisted: true }] }) };
  const r = await resolveSymbols(api, ['btc', 'DOGEUSDC.P', 'HYPERLIQUID:KPEPEUSDC.P', 'OLDUSDC.P', 'NOPE', 'BTCUSDC.P']);
  assert.deepEqual(r.ok, ['BTCUSDC.P', 'DOGEUSDC.P', 'kPEPEUSDC.P']);
  assert.deepEqual(r.bad, ['OLDUSDC.P', 'NOPE']);
  const down = await resolveSymbols({ info: async () => { throw new Error('offline'); } }, ['DOGE']);
  assert.equal(down.unchecked, true);
  assert.deepEqual(down.ok, ['DOGE']);
});

test('previewSeq: minute order decides stop vs target, the stop does not trail, state untouched', () => {
  const e = KS.createEngine({ mode: 'Custom' }, '15m', { mintick: 0.01 });
  Object.assign(e.state, { dir: 1, entry: 100, sl: 90, tp1: 105, tp2: 110, tp3: 115, risk: 10, t1: false, t2: false, rem: 1, tradeR: 0, tradeId: 1 });
  e.state.prev.atr = 2;
  const m = (h, l, c = 100) => ({ t: 0, o: 100, h, l, c, v: 1 });
  assert.deepEqual(e.previewSeq([m(106, 99), m(100, 89)]).map((x) => x.type), ['TP1', 'TRAIL']); // target first, then back to entry
  assert.deepEqual(e.previewSeq([m(101, 89), m(106, 99)]).map((x) => x.type), ['SL']); // stop first: nothing after it
  assert.deepEqual(e.previewSeq([m(106, 100, 106)]).map((x) => x.type), ['TP1']);
  assert.equal(e.state.sl, 90);
  assert.equal(e.state.t1, false);
});

test('scheduled runs: every event once, nothing lost between runs, new market joins later', async () => {
  const mock = await startMock();
  const clock = { t: Date.UTC(2026, 10, 20, 0, 3, 0) };
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ks-once-')), 'data', 'state.json');
  const config = { symbols: ['BTCUSDC.P'], timeframes: ['15m'], settings: { mode: 'Custom' }, tpSlAlerts: 'live', maxAlertAgeSeconds: 900 };
  let a = await oneRun(mock.webhookUrl, clock, stateFile, config);
  assert.equal(a.hadSavedState, false);
  assert.ok([...a.streams.values()].every((s) => s.fresh));
  for (let i = 0; i < 96 * 3; i++) { // 3 days, a run every 15 minutes, as late as 7 minutes after the bar closed
    clock.t += i % 2 ? 1320000 : 480000; // runs 8 and 22 minutes apart, so some run lands 7 minutes after a close
    a = await oneRun(mock.webhookUrl, clock, stateFile, config);
    assert.equal(a.hadSavedState, true);
    assert.ok([...a.streams.values()].every((s) => !s.fresh), 'state restored, not rebuilt');
  }
  const embeds = mock.messages.flatMap((m) => m.embeds).filter((x) => !/online|watching/.test(x.title));
  assert.ok(embeds.length >= 3, 'expected some alerts, got ' + embeds.length);
  const keys = embeds.map((x) => `${x.title}|${x.footer.text}|${JSON.stringify(x.fields)}`);
  assert.equal(new Set(keys).size, keys.length, 'no message was sent twice');
  // add a market: only the new one is built from history, the old one keeps its state
  config.symbols.push('ETHUSDC.P');
  clock.t += 900000;
  a = await oneRun(mock.webhookUrl, clock, stateFile, config);
  assert.equal(a.streams.get('ETH|15m').fresh, true);
  assert.equal(a.streams.get('BTC|15m').fresh, false);
  // remove it again: its saved state is dropped from the file
  config.symbols.pop();
  clock.t += 900000;
  a = await oneRun(mock.webhookUrl, clock, stateFile, config);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).streams), ['BTC|15m']);
  mock.close();
});

test('markets.js adds valid names and refuses unknown ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ks-mk-'));
  const file = join(dir, 'symbols.txt');
  writeFileSync(file, '# my markets\nBTCUSDC.P\n');
  const mock = await startMock();
  // spawnSync would freeze the fake exchange that runs in this same process, so use the async version
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['server/markets.js', ...args], { env: { ...process.env, KS_SYMBOLS: file, HL_API_URL: mock.url } }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
  const ok = await run('add', 'doge, ethusdc.p');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(file, 'utf8'), '# my markets\nBTCUSDC.P\nDOGEUSDC.P\nETHUSDC.P\n');
  const bad = await run('add', 'NOTACOIN');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /NOTACOIN/);
  assert.equal(readFileSync(file, 'utf8'), '# my markets\nBTCUSDC.P\nDOGEUSDC.P\nETHUSDC.P\n');
  assert.equal((await run('remove', 'DOGE')).status, 0);
  assert.equal(readFileSync(file, 'utf8'), '# my markets\nBTCUSDC.P\nETHUSDC.P\n');
  mock.close();
});
