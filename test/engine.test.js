import test from 'node:test';
import assert from 'node:assert/strict';
import { info } from './mock.js';
import '../public/shared/market.js';
import '../public/shared/engine.js';
const KS = globalThis.KS;
const NOW = Date.UTC(2026, 10, 27, 6, 50);
const fakeApi = (now = NOW) => {
  const api = {
    candles: async (coin, interval, start, end = now) => info({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }, now).map(KS.parseCandle),
    history: async (coin, tf, count = 5000, at = now) => {
      const base = KS.TIMEFRAMES[tf].base;
      const bars = KS.aggregate(await api.candles(coin, base, at - count * KS.BASE_MS[base], at), tf);
      if (bars.length > 1 && tf !== '1W' && tf !== '1M' && bars[0].first !== bars[0].t) bars.shift();
      return bars;
    },
  };
  return api;
};

test('all 14 requested timeframes exist', () => {
  assert.deepEqual(KS.CHART_TIMEFRAMES, ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1D', '1W']);
});

test('candles aggregate correctly and weeks start on Monday', () => {
  const m15 = [0, 1, 2, 3].map((i) => ({ t: Date.UTC(2026, 0, 5) + i * 900000, o: 10 + i, h: 20 + i, l: 5 - i, c: 11 + i, v: 1 }));
  const [a, b] = KS.aggregate(m15, '45m');
  assert.deepEqual([a.o, a.h, a.l, a.c, a.v], [10, 22, 3, 13, 3]);
  assert.equal(b.t - a.t, 2700000);
  const week = KS.bucketStart(NOW, '1W');
  assert.equal(new Date(week).getUTCDay(), 1);
  assert.equal(new Date(week).toISOString(), '2026-11-23T00:00:00.000Z');
});

test('symbols and presets', () => {
  assert.equal(KS.coinOf('HYPEUSDC.P'), 'HYPE');
  assert.equal(KS.coinOf('HYPERLIQUID:BTCUSDC.P'), 'BTC');
  const c = KS.effective({}, '15m');
  assert.deepEqual([c.minPass, c.minConf, c.slMult, c.tp1R, c.tp2R, c.tp3R, c.htfTf], [11, 80, 2.5, 0.5, 1.0, 1.5, '1h']);
});

test('higher-timeframe value is the previous real candle on every chart timeframe', async () => {
  for (const [tf, extra] of [['45m', {}], ['2m', {}], ['15m', {}], ['1W', {}], ['4h', { autoHtf: false, htfIn: '15m' }]]) {
    const api = fakeApi();
    const { engine, bars } = await KS.bootstrap(api, 'BTC', tf, extra, { now: NOW, count: 1500 });
    const htf = await api.history('BTC', engine.cfg.htfTf, 5000, NOW);
    let checked = 0;
    for (const b of bars.slice(0, -1)) {
      const row = engine.step(b);
      const prev = htf.filter((k) => k.t < KS.bucketStart(b.t, engine.cfg.htfTf)).at(-1);
      if (prev) { assert.equal(row.htfC, prev.c, `${tf} ${new Date(b.t).toISOString()}`); checked++; }
    }
    assert.ok(checked > 20, tf);
  }
});

test('saving and restoring the engine gives identical results', async () => {
  const { engine, bars } = await KS.bootstrap(fakeApi(), 'ETH', '15m', { mode: 'Custom' }, { now: NOW });
  const twin = KS.createEngine({ mode: 'Custom' }, '15m');
  twin.addHtf(engine.state.htf.pending);
  let other = twin, signals = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i % 700 === 350) other = KS.createEngine({ mode: 'Custom' }, '15m', { state: KS.loadState(KS.saveState(other.state)) });
    const a = engine.step(bars[i]), b = other.step(bars[i]);
    assert.deepEqual(b.events, a.events);
    assert.deepEqual(b.filtersL, a.filtersL);
    signals += a.events.length;
  }
  assert.ok(signals > 50, 'the test data should produce signals');
});

test('trade maths: partial targets, ratchet, stop-first rule, preview is read-only', () => {
  const e = KS.createEngine({}, '15m');
  Object.assign(e.state, { dir: 1, entry: 100, sl: 90, tp1: 105, tp2: 110, tp3: 115, risk: 10, tradeId: 1 });
  e.state.prev.atr = 4;
  const before = KS.saveState(e.state);
  const ev = e.preview({ t: 2, o: 100, h: 111, l: 99, c: 110 });
  assert.deepEqual(ev.map((x) => x.type), ['TP1', 'TP2']);
  assert.equal(ev[1].newStop, 105);
  assert.equal(KS.saveState(e.state), before);
  assert.deepEqual(e.preview({ t: 2, o: 100, h: 120, l: 89, c: 100 }).map((x) => x.type), ['SL']);
  assert.equal(e.preview({ t: 2, o: 100, h: 100, l: 89, c: 90 })[0].tradeR, -1);
  const all = e.preview({ t: 2, o: 100, h: 116, l: 99, c: 115 });
  assert.deepEqual(all.map((x) => x.type), ['TP1', 'TP2', 'TP3']);
  assert.ok(Math.abs(all[2].tradeR - (0.5 * 0.5 + 0.3 * 1.0 + 0.2 * 1.5)) < 1e-9);
});

test('an unconfirmed bar never creates an entry', async () => {
  const { engine, bars } = await KS.bootstrap(fakeApi(), 'SOL', '5m', { mode: 'Custom' }, { now: NOW });
  for (const b of bars.slice(0, 2000)) {
    const copy = KS.createEngine({ mode: 'Custom' }, '5m', { state: KS.loadState(KS.saveState(engine.state)) });
    assert.ok(!copy.step(b, false).events.some((e) => e.type === 'BUY' || e.type === 'SELL'));
    engine.step(b);
  }
});
