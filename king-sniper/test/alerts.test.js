import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock, info } from './mock.js';
import { createSender, embedFor } from '../server/discord.js';
import { createAlerts } from '../server/alerts.js';
import '../public/shared/market.js';
const KS = globalThis.KS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

function setup(webhookUrl, clock, stateFile = join(mkdtempSync(join(tmpdir(), 'ks-')), 'state.json')) {
  const api = {
    candles: async (coin, interval, start, end) => info({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }, clock.t).map(KS.parseCandle),
    history: async (coin, tf, count = 5000) => {
      const base = KS.TIMEFRAMES[tf].base;
      const bars = KS.aggregate(await api.candles(coin, base, clock.t - count * KS.BASE_MS[base], clock.t), tf);
      if (bars.length > 1 && bars[0].first !== bars[0].t && tf !== '1W' && tf !== '1M') bars.shift();
      return bars;
    },
  };
  const config = { symbols: ['BTCUSDC.P'], timeframes: ['15m'], settings: { mode: 'Custom' }, tpSlAlerts: 'live', maxAlertAgeSeconds: 180 };
  return { alerts: createAlerts({ config, api, webhookUrl, stateFile, log: quiet, now: () => clock.t }), stateFile };
}
const titles = (mock) => mock.messages.flatMap((m) => m.embeds.map((e) => e.title));

test('4 simulated days of bar closes: every event is delivered exactly once, also across a restart', async () => {
  const mock = await startMock();
  const clock = { t: Date.UTC(2026, 10, 20, 0, 0, 10) };
  let { alerts, stateFile } = setup(mock.webhookUrl, clock);
  await alerts.tick();
  alerts.announceOpen();
  const expected = [];
  const s = () => alerts.streams.get('BTC|15m');
  for (let i = 0; i < 96 * 4; i++) {
    clock.t += 900000;
    if (i === 150) { alerts.saveNow(); ({ alerts } = setup(mock.webhookUrl, clock, stateFile)); }
    await alerts.tick();
    await alerts.sender.flush();
  }
  // replay the same history independently
  const ref = KS.createEngine({ mode: 'Custom' }, '15m', { mintick: s().engine.state.mintick });
  const start = Date.UTC(2026, 10, 20, 0, 0, 0);
  const api = { history: async (c, tf, n, at) => { const base = KS.TIMEFRAMES[tf].base; const b = KS.aggregate(info({ type: 'candleSnapshot', req: { coin: c, interval: base, startTime: at - n * KS.BASE_MS[base], endTime: at } }, at).map(KS.parseCandle), tf); if (b.length > 1 && b[0].first !== b[0].t) b.shift(); return b; } };
  const boot = await KS.bootstrap(api, 'BTC', '15m', { mode: 'Custom' }, { now: start + 10000 });
  for (const b of boot.bars.filter((b) => b.t < start)) boot.engine.step(b);
  const announcedAtStart = boot.engine.stats().dir ? boot.engine.stats().tradeId : null;
  await boot.engine.syncHtf(api, 'BTC', clock.t);
  const later = await api.history('BTC', '15m', 400, clock.t);
  const known = new Set(announcedAtStart ? [announcedAtStart] : []);
  for (const b of later.filter((b) => b.t >= start && b.t + 900000 + 3000 <= clock.t)) {
    for (const e of boot.engine.step(b).events) {
      if (e.type === 'BUY' || e.type === 'SELL') known.add(e.tradeId);
      if (known.has(e.tradeId)) expected.push(e.type);
    }
  }
  const got = alerts.recent.map((r) => r.type);
  assert.ok(expected.length > 5, 'expected some signals, got ' + expected.length);
  assert.deepEqual(got, expected);
  assert.equal(titles(mock).length, expected.length);
  mock.close();
});

test('old signals are not sent after downtime', async () => {
  const mock = await startMock();
  const clock = { t: Date.UTC(2026, 10, 20, 0, 0, 10) };
  const { alerts } = setup(mock.webhookUrl, clock);
  await alerts.tick();
  clock.t += 86400000; // a day offline
  await alerts.tick();
  await alerts.sender.flush();
  assert.ok(alerts.recent.filter((r) => r.late && (r.type === 'BUY' || r.type === 'SELL')).length === 0);
  assert.ok(alerts.recent.length <= 5);
  mock.close();
});

test('live TP / SL: once only, nothing after the stop, correction after a live TP3', async () => {
  const mock = await startMock();
  const clock = { t: Date.UTC(2026, 10, 20, 0, 5, 0) };
  const { alerts } = setup(mock.webhookUrl, clock);
  await alerts.tick();
  const s = alerts.streams.get('BTC|15m');
  const open = (tradeId) => { Object.assign(s.engine.state, { dir: 1, entry: 100, sl: 90, tp1: 105, tp2: 110, tp3: 115, risk: 10, t1: false, t2: false, rem: 1, tradeR: 0, tradeId }); alerts.announceOpen(); };
  const live = (h, l) => alerts.onLiveCandle({ s: 'BTC', t: s.nextTime + 60000, o: 100, h, l, c: 100, v: 1 });
  open(1);
  live(106, 99); live(106, 99); live(100, 89); live(111, 99);
  await sleep(20); await alerts.sender.flush();
  assert.deepEqual(alerts.recent.map((r) => r.type), ['TP1', 'SL']);
  open(2);
  live(116, 99);
  await sleep(20); await alerts.sender.flush();
  assert.deepEqual(alerts.recent.slice(2).map((r) => r.type), ['TP1', 'TP2', 'TP3']);
  // unknown trade (never announced) stays silent
  Object.assign(s.engine.state, { tradeId: 3, dir: 1, sl: 90 });
  live(100, 80);
  assert.equal(alerts.recent.length, 5);
  assert.ok(!JSON.stringify(mock.messages).includes('127.0.0.1'));
  mock.close();
});

test('Discord rate limit is retried; an expired entry and its exits are dropped', async () => {
  let calls = 0;
  const mock = await startMock({ webhook: () => (++calls === 1 ? { status: 429, body: { retry_after: 0.05 } } : { status: 200 }) });
  const sender = createSender({ webhookUrl: mock.webhookUrl, log: quiet });
  const embed = (type) => embedFor({ event: { type, dir: 1, price: 1, entry: 1, sl: 0.9, tp1: 1.1, tp2: 1.2, tp3: 1.3, conf: 90, score: 11, n: 0, qty: 1, notional: 1, barTime: Date.now() }, symbol: 'X', tf: '1m', mode: 'm' });
  await sender.send([embed('BUY')]);
  assert.equal(calls, 2);
  assert.equal(mock.messages.length, 1);
  const dropped = [];
  const old = createSender({ webhookUrl: mock.webhookUrl, log: quiet, onExpire: (t) => dropped.push(t) });
  await old.send([embed('BUY'), embed('TP1'), embed('SL')], [
    { trade: 'a', entry: true, deadline: Date.now() - 1 }, { trade: 'a', entry: false, deadline: Date.now() + 9999 }, { trade: 'b', entry: false, deadline: Date.now() - 1 },
  ]);
  assert.deepEqual(dropped, ['a']);
  assert.equal(mock.messages[1].embeds.length, 1);
  assert.match(mock.messages[1].embeds[0].footer.text, /DELAYED/);
  mock.close();
});

test('a deleted webhook is reported without retrying forever', async () => {
  const mock = await startMock({ webhook: () => ({ status: 404 }) });
  const sender = createSender({ webhookUrl: mock.webhookUrl, log: quiet });
  await sender.send([{ title: 'x', footer: { text: '' } }]);
  assert.match(sender.status.lastError, /DISCORD_WEBHOOK_URL/);
  assert.equal(sender.queue.length, 0);
  mock.close();
});
