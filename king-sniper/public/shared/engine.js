// King Sniper Smart Filter: JavaScript port of indicator/king_sniper_smart_filter.pine
// One call to engine.step(bar) = one Pine script execution on a closed bar.
// All state is plain data so it can be saved to disk and restored.
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});

  // ───────────── inputs (same names and defaults as the Pine script) ─────────────
  const S = (key, def, label, group, extra = {}) => ({ key, def, label, group, ...extra });
  const SCHEMA = [
    S('mode', 'High win-rate', 'Strategy mode', 'Mode', { options: ['Custom', 'High win-rate', 'Max win-rate'] }),
    S('minConfIn', 0, 'Custom mode: min confidence %', 'Mode'),
    S('autoHtf', true, 'Auto-pick higher timeframe', 'Mode'),
    S('minPassIn', 10, 'Custom mode: min filters (of 12)', 'Filter engine'),
    S('emaFastL', 21, 'EMA fast', 'Filter engine'), S('emaSlowL', 50, 'EMA slow', 'Filter engine'), S('emaTrendL', 200, 'EMA trend', 'Filter engine'),
    S('htfIn', '1h', 'Higher timeframe (if auto is off)', 'Filter engine', { options: ['15m', '1h', '4h', '1D', '1W', '1M'] }),
    S('htfEmaL', 50, 'HTF EMA length', 'Filter engine'),
    S('rsiL', 14, 'RSI length', 'Filter engine'), S('rsiMaxL', 75, 'Long: RSI must be below', 'Filter engine'), S('rsiMinS', 25, 'Short: RSI must be above', 'Filter engine'),
    S('adxMin', 20, 'ADX minimum', 'Filter engine'), S('atrL', 14, 'ATR length', 'Filter engine'),
    S('atrRelMin', 0.5, 'Min ATR vs its 100-bar average (x)', 'Filter engine'),
    S('atrRelMax', 3.0, 'Max ATR band (x of 100-bar average)', 'Filter engine'),
    S('volMult', 1.0, 'Volume > SMA(20) x', 'Filter engine'),
    S('stFactor', 3.0, 'Supertrend factor', 'Filter engine'), S('stLen', 10, 'Supertrend ATR length', 'Filter engine'),
    S('brkLen', 20, 'Breakout lookback (bars)', 'Filter engine'), S('brkRecent', 3, 'Breakout within last N bars', 'Filter engine'),
    ...['EMA fast/slow stack', 'Price vs EMA trend', 'HTF trend', 'RSI', 'MACD histogram', 'ADX + DI', 'ATR volatility band', 'Volume', 'Supertrend', 'Breakout structure', 'Session filter (hard gate)', 'News / spike protection (hard gate)']
      .map((n, i) => S('u' + (i + 1), i !== 10, `${i + 1}  ${n}`, 'Filters on/off')),
    S('sessTz', 'Asia/Manila', 'Timezone for session & news windows', 'Session & news'),
    S('sessStr', '0800-2200', 'Allowed trading session', 'Session & news'),
    S('nw1On', false, 'Blackout window 1 on', 'Session & news'), S('nw1', '2100-2200', 'Window 1', 'Session & news'),
    S('nw2On', false, 'Blackout window 2 on', 'Session & news'), S('nw2', '0200-0300', 'Window 2', 'Session & news'),
    S('nw3On', false, 'Blackout window 3 on', 'Session & news'), S('nw3', '0000-0100', 'Window 3', 'Session & news'),
    S('spikeOn', true, 'Spike guard', 'Session & news'), S('spikeMult', 2.5, 'Spike = true range > ATR x', 'Session & news'), S('spikeCool', 3, 'Block N bars after spike', 'Session & news'),
    S('slMultIn', 1.5, 'Custom: stop loss = ATR x', 'Trade management'),
    S('tp1RIn', 1.0, 'Custom: TP1 (R)', 'Trade management'), S('tp2RIn', 2.0, 'Custom: TP2 (R)', 'Trade management'), S('tp3RIn', 3.0, 'Custom: TP3 (R)', 'Trade management'),
    S('p1In', 0.4, 'Custom: close fraction at TP1', 'Trade management'), S('p2In', 0.3, 'Custom: close fraction at TP2', 'Trade management'),
    S('ratchetOn', true, 'Ratchet stop (TP1 → entry, TP2 → TP1)', 'Trade management'),
    S('trailOn', true, 'ATR trailing stop after TP1', 'Trade management'), S('trailMult', 2.0, 'Trail distance = ATR x', 'Trade management'),
    S('cooldown', 3, 'Cooldown bars after a trade', 'Trade management'),
    S('flipOn', true, 'Flip after full stop-out', 'Flip recovery'), S('flipBars', 6, 'Flip window (bars)', 'Flip recovery'),
    S('flipMin', 8, 'Min filters for opposite side', 'Flip recovery'), S('maxFlips', 1, 'Max consecutive flips', 'Flip recovery'),
    S('acct', 100.0, 'Account size (USDC)', 'Risk'), S('riskPct', 0.5, 'Risk per trade %', 'Risk'),
    S('ddTarget', 15.0, 'Target max drawdown %', 'Drawdown protection'), S('ddHalt', 12.0, 'Pause when drawdown reaches %', 'Drawdown protection'),
    S('maxLoss', 3, 'Pause after N losses in a row', 'Drawdown protection'), S('dailyLossR', 3.0, 'Daily loss limit (R)', 'Drawdown protection'),
    S('pauseHrs', 8.0, 'Pause length (hours)', 'Drawdown protection'),
    S('useHourGate', false, 'Skip PHT hours that historically lose', 'Best time'), S('minHourTrades', 5, 'Min trades before an hour is rated', 'Best time'), S('blockBelowR', 0.0, 'Block rated hours with avg R below', 'Best time'),
  ];
  const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.def]));
  const FILTER_NAMES = ['EMA stack', 'Price vs EMA trend', 'HTF trend', 'RSI', 'MACD', 'ADX / DI', 'ATR band', 'Volume', 'Supertrend', 'Breakout', 'Session', 'News / spike'];

  // mode presets + timeframe scaling
  function effective(input, tf) {
    const c = { ...DEFAULTS, ...input };
    const isHigh = c.mode === 'High win-rate', isMax = c.mode === 'Max win-rate';
    const pick = (m, h, own) => (isMax ? m : isHigh ? h : own);
    const tfs = KS.TIMEFRAMES[tf].sec;
    Object.assign(c, {
      minPass: pick(12, 11, c.minPassIn), minConf: pick(85, 80, c.minConfIn), slMult: pick(3.0, 2.5, c.slMultIn),
      tp1R: pick(0.4, 0.5, c.tp1RIn), tp2R: pick(0.8, 1.0, c.tp2RIn), tp3R: pick(1.2, 1.5, c.tp3RIn),
      p1: pick(0.6, 0.5, c.p1In), p2: pick(0.25, 0.3, c.p2In),
      tfs, tf, pauseBars: Math.max(1, Math.ceil((c.pauseHrs * 3600) / tfs)),
    });
    c.htfTf = c.autoHtf ? (tfs <= 180 ? '15m' : tfs <= 900 ? '1h' : tfs <= 3600 ? '4h' : tfs <= 14400 ? '1D' : tfs <= 86400 ? '1W' : '1M') : c.htfIn;
    return c;
  }

  // ───────────── Pine ta.* equivalents ─────────────
  function ema(s, x, len) {
    const a = 2 / (len + 1);
    s.v = Number.isNaN(s.v) ? x : a * x + (1 - a) * s.v;
    return s.v;
  }
  function rma(s, x, len) {
    if (Number.isNaN(x)) return s.v;
    if (Number.isNaN(s.v)) {
      s.buf.push(x);
      if (s.buf.length === len) { s.v = s.buf.reduce((a, b) => a + b, 0) / len; s.buf = []; }
    } else s.v = (x + (len - 1) * s.v) / len;
    return s.v;
  }
  function sma(buf, x, len) {
    if (!Number.isNaN(x)) { buf.push(x); if (buf.length > len) buf.shift(); }
    if (buf.length < len) return NaN;
    let t = 0;
    for (const v of buf) t += v;
    return t / len;
  }
  const since = (prev, cond) => (cond ? 0 : prev + 1); // NaN + 1 stays NaN until first true
  const nz = (x, r = 0) => (Number.isNaN(x) ? r : x);

  // ───────────── time helpers ─────────────
  const fmtCache = {};
  function minutesIn(t, tz) {
    if (tz === 'Asia/Manila') return Math.floor((t + 8 * 3600000) / 60000) % 1440;
    const f = (fmtCache[tz] ||= new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    const [h, m] = f.format(t).split(':').map(Number);
    return h * 60 + m;
  }
  function inSession(t, sess, tz) {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(sess || '');
    if (!m) return false;
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4], x = minutesIn(t, tz);
    return a < b ? x >= a && x < b : x >= a || x < b;
  }
  const phtHour = (t) => Math.floor(minutesIn(t, 'Asia/Manila') / 60);
  function marketSessions(t, tfs) {
    if (tfs >= 86400) return { tok: false, lon: false, ny: false };
    return { tok: inSession(t, '0900-1800', 'Asia/Tokyo'), lon: inSession(t, '0800-1630', 'Europe/London'), ny: inSession(t, '0830-1700', 'America/New_York') };
  }

  // ───────────── trade management (shared by closed bars and live preview) ─────────────
  function manage(s, bar, atr, c, events, trail = true) {
    if (s.dir === 0) return false;
    const long = s.dir === 1;
    const ev = (type, price, extra) => events.push({ type, price, dir: s.dir, entry: s.entry, tradeId: s.tradeId, barTime: bar.t, ...extra });
    if (long ? bar.l <= s.sl : bar.h >= s.sl) {
      s.tradeR += (s.rem * s.dir * (s.sl - s.entry)) / s.risk;
      ev(s.t1 ? 'TRAIL' : 'SL', s.sl, { closed: true, tradeR: s.tradeR });
      return true;
    }
    let closed = false;
    if (!s.t1 && (long ? bar.h >= s.tp1 : bar.l <= s.tp1)) {
      s.t1 = true; s.tradeR += c.p1 * c.tp1R; s.rem -= c.p1;
      if (c.ratchetOn) s.sl = long ? Math.max(s.sl, s.entry) : Math.min(s.sl, s.entry);
      ev('TP1', s.tp1, { newStop: s.sl });
    }
    if (s.t1 && !s.t2 && (long ? bar.h >= s.tp2 : bar.l <= s.tp2)) {
      s.t2 = true; s.tradeR += c.p2 * c.tp2R; s.rem -= c.p2;
      if (c.ratchetOn) s.sl = long ? Math.max(s.sl, s.tp1) : Math.min(s.sl, s.tp1);
      ev('TP2', s.tp2, { newStop: s.sl });
    }
    if (s.t2 && (long ? bar.h >= s.tp3 : bar.l <= s.tp3)) {
      s.tradeR += s.rem * c.tp3R; s.rem = 0; closed = true;
      ev('TP3', s.tp3, { closed: true, tradeR: s.tradeR });
    }
    if (trail && s.t1 && c.trailOn && !closed) {
      const px = long ? bar.c - atr * c.trailMult : bar.c + atr * c.trailMult;
      if (!Number.isNaN(px)) s.sl = long ? Math.max(s.sl, px) : Math.min(s.sl, px);
    }
    return closed;
  }

  function freshState() {
    const e = () => ({ v: NaN }), r = () => ({ v: NaN, buf: [] });
    return {
      i: -1, lastTime: 0,
      emaF: e(), emaS: e(), emaT: e(), m12: e(), m26: e(), msig: e(),
      rsiU: r(), rsiD: r(), trur: r(), dmP: r(), dmM: r(), dx: r(), atr: r(), stAtr: r(),
      diP: NaN, diM: NaN, atrBuf: [], volBuf: [], highs: [], lows: [],
      st: { upper: NaN, lower: NaN, line: NaN, atr: NaN, dir: 1 },
      prev: { c: NaN, h: NaN, l: NaN, hist: NaN, atr: NaN, longRaw: false, shortRaw: false },
      sinceUp: NaN, sinceDn: NaN, sinceSpike: NaN,
      htf: { pending: [], lastT: null, ema: { v: NaN }, prevC: NaN, prevE: NaN },
      // trade engine
      dir: 0, entry: NaN, sl: NaN, tp1: NaN, tp2: NaN, tp3: NaN, risk: NaN, t1: false, t2: false, rem: 1, tradeR: 0, tradeId: 0,
      lastCloseBar: NaN, lastCloseDir: 0, lastFullSL: false, flipCount: 0,
      trades: 0, wins: 0, totalR: 0, qty: NaN, eq: 100, peakEq: 100, maxDD: 0, cumR: 0, peakR: 0, maxDDR: 0,
      consecLoss: 0, dayR: 0, day: null, pausedUntil: 0,
      arrT: Array(13).fill(0), arrW: Array(13).fill(0), entryScore: 0, lastConf: NaN, sumW: 0, sumL: 0, lastWR: NaN, lastN: 0,
      hrT: Array(24).fill(0), hrW: Array(24).fill(0), hrR: Array(24).fill(0), entryHour: 0,
    };
  }

  function createEngine(settings, tf, opts = {}) {
    const c = effective(settings, tf);
    const s = opts.state || freshState();
    if (opts.mintick) s.mintick = opts.mintick;
    const mintick = s.mintick || 0;

    // request.security(htf, [close[1], ema[1]], lookahead_on): every chart bar reads the last real
    // higher-timeframe candle that comes before the one containing the chart bar's open.
    const htfLast = () => (s.htf.pending.length ? s.htf.pending[s.htf.pending.length - 1].t : s.htf.lastT);
    function addHtf(candles) {
      for (const k of candles) if (htfLast() === null || k.t > htfLast()) s.htf.pending.push({ t: k.t, c: k.c });
    }
    function htfReady(barTime) {
      const previous = KS.bucketStart(KS.bucketStart(barTime, c.htfTf) - 1, c.htfTf);
      return htfLast() !== null && htfLast() >= previous;
    }
    function advanceHtf(barTime) {
      const h = s.htf, bucket = KS.bucketStart(barTime, c.htfTf);
      let n = 0;
      while (n < h.pending.length && h.pending[n].t < bucket) {
        const k = h.pending[n++];
        h.lastT = k.t;
        h.prevC = k.c;
        h.prevE = ema(h.ema, k.c, c.htfEmaL);
      }
      if (n) h.pending.splice(0, n);
    }
    // Download the higher-timeframe candles that have closed since the last call.
    // `since` (first chart bar) limits the first download to that span plus 600 candles of EMA warm-up.
    async function syncHtf(api, coin, now = Date.now(), since = null) {
      const from = htfLast();
      const baseMs = KS.BASE_MS[KS.TIMEFRAMES[c.htfTf].base];
      const span = KS.TIMEFRAMES[c.htfTf].sec * 1000;
      const reach = from !== null ? now - from + 2 * span : since !== null ? now - since + Math.max(600, 6 * c.htfEmaL) * span : null;
      const count = reach === null ? KS.MAX_CANDLES : Math.ceil(reach / baseMs);
      const bars = await api.history(coin, c.htfTf, Math.min(KS.MAX_CANDLES, count), now);
      addHtf(bars.filter((b) => {
        const end = KS.bucketEnd(b.t, c.htfTf);
        return end <= now && !(b.last < end - baseMs && now < end + 30000);
      }));
    }

    function step(bar, confirmed = true) {
      const { o, h, l, c: close, v } = bar;
      const p = s.prev;
      s.i += 1;
      const i = s.i;
      s.lastTime = bar.t;

      // ───── indicators ─────
      const emaF = ema(s.emaF, close, c.emaFastL), emaS = ema(s.emaS, close, c.emaSlowL), emaT = ema(s.emaT, close, c.emaTrendL);
      advanceHtf(bar.t);
      const htfC = s.htf.prevC, htfE = s.htf.prevE;

      const chg = close - p.c;
      const up = rma(s.rsiU, Number.isNaN(chg) ? NaN : Math.max(chg, 0), c.rsiL);
      const dn = rma(s.rsiD, Number.isNaN(chg) ? NaN : Math.max(-chg, 0), c.rsiL);
      const rsi = Number.isNaN(up) || Number.isNaN(dn) ? NaN : dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);

      const macd = ema(s.m12, close, 12) - ema(s.m26, close, 26);
      const hist = macd - ema(s.msig, macd, 9);

      const trNa = Number.isNaN(p.c) ? NaN : Math.max(h - l, Math.abs(h - p.c), Math.abs(l - p.c));
      const tr = Number.isNaN(p.c) ? h - l : trNa;
      const mUp = h - p.h, mDn = p.l - l;
      const trur = rma(s.trur, trNa, 14);
      const rp = rma(s.dmP, Number.isNaN(mUp) ? NaN : mUp > mDn && mUp > 0 ? mUp : 0, 14);
      const rm = rma(s.dmM, Number.isNaN(mDn) ? NaN : mDn > mUp && mDn > 0 ? mDn : 0, 14);
      const rawP = (100 * rp) / trur, rawM = (100 * rm) / trur;
      if (Number.isFinite(rawP)) s.diP = rawP; // fixnan
      if (Number.isFinite(rawM)) s.diM = rawM;
      const diP = s.diP, diM = s.diM, sum = diP + diM;
      const adx = 100 * rma(s.dx, Math.abs(diP - diM) / (sum === 0 ? 1 : sum), 14);

      const atr = rma(s.atr, tr, c.atrL);
      const atrAvg = sma(s.atrBuf, atr, 100);
      const volAvg = sma(s.volBuf, v, 20);

      // supertrend
      const stAtr = rma(s.stAtr, tr, c.stLen);
      const st = s.st;
      let upper = (h + l) / 2 + c.stFactor * stAtr, lower = (h + l) / 2 - c.stFactor * stAtr;
      const pl = nz(st.lower), pu = nz(st.upper);
      lower = lower > pl || p.c < pl ? lower : pl;
      upper = upper < pu || p.c > pu ? upper : pu;
      let stDir;
      if (Number.isNaN(st.atr)) stDir = 1;
      else if (st.line === pu) stDir = close > upper ? -1 : 1;
      else stDir = close < lower ? 1 : -1;
      Object.assign(st, { upper, lower, dir: stDir, atr: stAtr, line: stDir === -1 ? lower : upper });

      const full = s.highs.length === c.brkLen;
      const donHi = full ? Math.max(...s.highs) : NaN, donLo = full ? Math.min(...s.lows) : NaN;
      s.highs.push(h); s.lows.push(l);
      if (s.highs.length > c.brkLen) { s.highs.shift(); s.lows.shift(); }
      s.sinceUp = since(s.sinceUp, close > donHi);
      s.sinceDn = since(s.sinceDn, close < donLo);
      s.sinceSpike = since(s.sinceSpike, tr > atr * c.spikeMult);

      // ───── 12 filters ─────
      const inSess = inSession(bar.t, c.sessStr, c.sessTz);
      const inNews = (c.nw1On && inSession(bar.t, c.nw1, c.sessTz)) || (c.nw2On && inSession(bar.t, c.nw2, c.sessTz)) || (c.nw3On && inSession(bar.t, c.nw3, c.sessTz));
      const volOk = Number.isNaN(v) || v > volAvg * c.volMult;
      const spikeOk = !c.spikeOn || nz(s.sinceSpike, 9999) > c.spikeCool;
      const newsOk = !inNews && spikeOk;
      const f7 = !c.u7 || (atr >= atrAvg * c.atrRelMin && atr <= atrAvg * c.atrRelMax);
      const f8 = !c.u8 || volOk;
      const f11 = !c.u11 || inSess;
      const f12 = !c.u12 || newsOk;
      const L = [
        !c.u1 || emaF > emaS, !c.u2 || close > emaT, !c.u3 || htfC > htfE, !c.u4 || (rsi > 50 && rsi < c.rsiMaxL),
        !c.u5 || (hist > 0 && hist > p.hist), !c.u6 || (adx > c.adxMin && diP > diM), f7, f8,
        !c.u9 || stDir < 0, !c.u10 || nz(s.sinceUp, 9999) <= c.brkRecent, f11, f12,
      ];
      const Sh = [
        !c.u1 || emaF < emaS, !c.u2 || close < emaT, !c.u3 || htfC < htfE, !c.u4 || (rsi < 50 && rsi > c.rsiMinS),
        !c.u5 || (hist < 0 && hist < p.hist), !c.u6 || (adx > c.adxMin && diM > diP), f7, f8,
        !c.u9 || stDir > 0, !c.u10 || nz(s.sinceDn, 9999) <= c.brkRecent, f11, f12,
      ];
      const scoreL = L.filter(Boolean).length, scoreS = Sh.filter(Boolean).length;
      const conf = (sc) => Math.round((sc / 12) * 75 + (Math.min(adx, 40) / 40) * 25);
      const gate = f11 && f12;
      const longRaw = scoreL >= c.minPass && conf(scoreL) >= c.minConf && gate;
      const shortRaw = scoreS >= c.minPass && conf(scoreS) >= c.minConf && gate;
      const longTrig = longRaw && !p.longRaw, shortTrig = shortRaw && !p.shortRaw;

      // ───── trade engine ─────
      const day = Math.floor(bar.t / 86400000);
      if (s.day !== null && day !== s.day) s.dayR = 0;
      s.day = day;

      const events = [];
      // 1) manage the open trade (stop is checked first = conservative)
      const closedNow = manage(s, bar, atr, c, events);

      // 2) book the closed trade
      if (closedNow) {
        const R = s.tradeR, win = R > 0;
        s.trades += 1;
        if (win) { s.wins += 1; s.sumW += R; s.arrW[s.entryScore] += 1; s.hrW[s.entryHour] += 1; } else s.sumL += -R;
        s.totalR += R;
        s.arrT[s.entryScore] += 1;
        s.hrT[s.entryHour] += 1;
        s.hrR[s.entryHour] += R;
        s.eq *= 1 + (R * c.riskPct) / 100;
        s.peakEq = Math.max(s.peakEq, s.eq);
        const ddNow = ((s.peakEq - s.eq) / s.peakEq) * 100;
        s.maxDD = Math.max(s.maxDD, ddNow);
        s.cumR += R;
        s.peakR = Math.max(s.peakR, s.cumR);
        s.maxDDR = Math.max(s.maxDDR, s.peakR - s.cumR);
        s.dayR += R;
        s.consecLoss = win ? 0 : s.consecLoss + 1;
        if (s.consecLoss >= c.maxLoss || ddNow >= c.ddHalt) { s.pausedUntil = i + c.pauseBars; s.consecLoss = 0; }
        s.lastCloseBar = i;
        s.lastCloseDir = s.dir;
        s.lastFullSL = events.some((e) => e.type === 'SL');
        s.dir = 0;
      }

      // 3) entries (conflict guard: only when flat, after cooldown)
      const curHr = phtHour(bar.t);
      const avg = s.hrT[curHr] >= c.minHourTrades ? s.hrR[curHr] / s.hrT[curHr] : null;
      const hourOk = !c.useHourGate || c.tfs >= 86400 || avg === null || avg >= c.blockBelowR;
      const cdOk = Number.isNaN(s.lastCloseBar) || i - s.lastCloseBar >= c.cooldown;
      const flipWin = c.flipOn && s.lastFullSL && !Number.isNaN(s.lastCloseBar) && i - s.lastCloseBar <= c.flipBars && i > s.lastCloseBar && s.flipCount < c.maxFlips;
      const normL = longTrig && cdOk && confirmed, normS = shortTrig && cdOk && confirmed;
      const flipL = flipWin && s.lastCloseDir === -1 && scoreL >= c.flipMin && gate && confirmed;
      const flipS = flipWin && s.lastCloseDir === 1 && scoreS >= c.flipMin && gate && confirmed;
      const riskOk = i >= s.pausedUntil && s.dayR > -c.dailyLossR && hourOk;
      let goLong = s.dir === 0 && !closedNow && riskOk && (normL || flipL);
      let goShort = s.dir === 0 && !closedNow && riskOk && (normS || flipS);
      if (goLong && goShort) goLong = goShort = false;
      if (goLong || goShort) {
        const isFlip = (goLong && flipL && !normL) || (goShort && flipS && !normS);
        const dir = goLong ? 1 : -1;
        const risk = Math.max(atr * c.slMult, mintick * 5);
        Object.assign(s, {
          dir, entry: close, risk, sl: close - dir * risk,
          tp1: close + dir * risk * c.tp1R, tp2: close + dir * risk * c.tp2R, tp3: close + dir * risk * c.tp3R,
          t1: false, t2: false, rem: 1, tradeR: 0, tradeId: bar.t,
          qty: (c.acct * c.riskPct) / 100 / risk, entryHour: curHr,
        });
        const sc = goLong ? scoreL : scoreS;
        s.entryScore = sc;
        s.lastConf = conf(sc);
        s.lastN = s.arrT[sc];
        s.lastWR = s.lastN >= 5 ? (s.arrW[sc] * 100) / s.lastN : NaN;
        s.flipCount = isFlip ? s.flipCount + 1 : 0;
        events.push({
          type: goLong ? 'BUY' : 'SELL', flip: isFlip, dir, price: close, entry: close, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
          conf: s.lastConf, score: sc, winRate: s.lastWR, n: s.lastN, qty: s.qty, notional: s.qty * close, tradeId: bar.t, barTime: bar.t,
        });
      }

      Object.assign(p, { c: close, h, l, hist, atr, longRaw, shortRaw });
      const open = s.dir !== 0;
      return {
        t: bar.t, o, h, l, c: close, v, emaF, emaS, emaT, events,
        entry: open ? s.entry : NaN, sl: open ? s.sl : NaN, tp1: open ? s.tp1 : NaN, tp2: open ? s.tp2 : NaN, tp3: open ? s.tp3 : NaN,
        filtersL: L, filtersS: Sh, scoreL, scoreS, rsi, adx, atr, htfC, htfE, hourOk,
      };
    }

    // What would happen to the open trade if this (unfinished) price range counted now?
    function preview(bar) {
      const events = [];
      manage({ ...s }, bar, s.prev.atr, c, events);
      return events;
    }

    // Same idea as preview, but for several 1-minute candles in time order (used when the program only
    // wakes up now and then and has no live feed). The stop does not trail between closed bars.
    function previewSeq(bars) {
      const events = [], copy = { ...s };
      for (const b of bars) if (manage(copy, b, s.prev.atr, c, events, false)) break;
      return events;
    }

    function stats() {
      const losses = s.trades - s.wins;
      return {
        position: s.dir === 1 ? 'LONG' : s.dir === -1 ? 'SHORT' : 'FLAT', stage: s.dir === 0 ? '-' : s.t2 ? 'TP2+' : s.t1 ? 'TP1+' : 'open',
        dir: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, tradeId: s.tradeId,
        trades: s.trades, winRate: s.trades ? (s.wins * 100) / s.trades : NaN, netR: s.totalR,
        qty: s.dir ? s.qty : NaN, notional: s.dir ? s.qty * s.entry : NaN,
        maxDD: s.maxDD, maxDDR: s.maxDDR, suggestedRisk: s.maxDDR > 0 ? (c.ddTarget * 0.5) / s.maxDDR : NaN,
        paused: s.i < s.pausedUntil || s.dayR <= -c.dailyLossR,
        lastConf: s.lastConf, lastWR: s.lastWR, lastN: s.lastN,
        avgWin: s.wins ? s.sumW / s.wins : NaN, avgLoss: losses ? s.sumL / losses : NaN,
        profitFactor: s.sumL > 0 ? s.sumW / s.sumL : NaN,
        hours: s.hrT.map((n, h) => ({ hour: h, trades: n, wins: s.hrW[h], netR: s.hrR[h], avgR: n >= c.minHourTrades ? s.hrR[h] / n : NaN })),
      };
    }

    return { cfg: c, state: s, addHtf, htfReady, syncHtf, step, preview, previewSeq, stats };
  }

  // JSON cannot hold NaN, so it is stored as a marker string.
  const saveState = (state) => JSON.stringify(state, (k, v) => (typeof v === 'number' && Number.isNaN(v) ? '~NaN' : v));
  const loadState = (text) => JSON.parse(text, (k, v) => (v === '~NaN' ? NaN : v));

  // Build an engine and replay closed history through it.
  async function bootstrap(api, coin, tf, settings, opts = {}) {
    const now = opts.now || Date.now();
    const bars = await api.history(coin, tf, opts.count || KS.MAX_CANDLES, now);
    const last = bars.length ? bars[bars.length - 1].c : 0;
    const engine = createEngine(settings, tf, { mintick: 10 ** -KS.decimalsFor(last) });
    await engine.syncHtf(api, coin, now, bars.length ? bars[0].t : null).catch((e) => { throw new Error(`higher-timeframe data: ${e.message}`); });
    return { engine, bars };
  }

  Object.assign(KS, { SCHEMA, DEFAULTS, FILTER_NAMES, effective, createEngine, saveState, loadState, bootstrap, marketSessions, phtHour, inSession });
})();
