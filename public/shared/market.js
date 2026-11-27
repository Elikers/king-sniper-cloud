// Timeframes, candle aggregation and the Hyperliquid public API.
// Plain script: used by the browser (<script>) and by the Node server (import).
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;

  // Hyperliquid has no native 2m, 10m, 45m or 3h candle, so those are built from smaller ones.
  // 1W is built from daily candles so the week starts Monday 00:00 UTC.
  const TIMEFRAMES = {
    '1m':  { sec: 60,     base: '1m'  },
    '2m':  { sec: 120,    base: '1m'  },
    '3m':  { sec: 180,    base: '3m'  },
    '5m':  { sec: 300,    base: '5m'  },
    '10m': { sec: 600,    base: '5m'  },
    '15m': { sec: 900,    base: '15m' },
    '30m': { sec: 1800,   base: '30m' },
    '45m': { sec: 2700,   base: '15m' },
    '1h':  { sec: 3600,   base: '1h'  },
    '2h':  { sec: 7200,   base: '2h'  },
    '3h':  { sec: 10800,  base: '1h'  },
    '4h':  { sec: 14400,  base: '4h'  },
    '1D':  { sec: 86400,  base: '1d'  },
    '1W':  { sec: 604800, base: '1d'  },
    '1M':  { sec: 2592000, base: '1d', htfOnly: true },
  };
  const CHART_TIMEFRAMES = Object.keys(TIMEFRAMES).filter((k) => !TIMEFRAMES[k].htfOnly);
  const BASE_MS = { '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '30m': 30 * MIN, '1h': HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '1d': DAY };
  const MAX_CANDLES = 5000; // Hyperliquid only serves the latest 5000 per interval

  function bucketStart(t, tf) {
    if (tf === '1W') {
      const day = Math.floor(t / DAY);
      return (day - ((day + 3) % 7)) * DAY; // 1970-01-01 was a Thursday
    }
    if (tf === '1M') {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
    const ms = TIMEFRAMES[tf].sec * 1000;
    return Math.floor(t / ms) * ms;
  }
  function bucketEnd(t, tf) {
    const s = bucketStart(t, tf);
    if (tf === '1M') {
      const d = new Date(s);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return s + TIMEFRAMES[tf].sec * 1000;
  }

  // base candles (sorted by time) -> candles of the requested timeframe
  function aggregate(candles, tf) {
    const out = [];
    let cur = null;
    for (const k of candles) {
      const t = bucketStart(k.t, tf);
      if (!cur || cur.t !== t) {
        cur = { t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, first: k.t, last: k.t };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, k.h);
        cur.l = Math.min(cur.l, k.l);
        cur.c = k.c;
        cur.v += k.v;
        cur.last = k.t;
      }
    }
    return out;
  }

  const parseCandle = (r) => ({ t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v });
  const coinOf = (symbol) => String(symbol).trim().replace(/^HYPERLIQUID:/i, '').replace(/[-/]?USDC(\.P)?$/i, '');
  const symbolOf = (coin) => coin + 'USDC.P';

  function decimalsFor(price) {
    if (!(price > 0)) return 2;
    return Math.max(0, Math.min(6, 4 - Math.floor(Math.log10(price))));
  }
  function fmtPrice(p) {
    if (p === null || p === undefined || !Number.isFinite(p)) return '-';
    const d = decimalsFor(Math.abs(p));
    return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // REST client with a simple weight budget (Hyperliquid allows 1200 weight / minute / IP).
  function createApi(opts = {}) {
    const url = opts.url || 'https://api.hyperliquid.xyz/info';
    const budget = opts.budget || 900;
    let used = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function reserve(weight) {
      for (;;) {
        const now = Date.now();
        used = used.filter((u) => now - u.at < 60000);
        const total = used.reduce((a, u) => a + u.w, 0);
        if (total + weight <= budget || used.length === 0) {
          used.push({ at: now, w: weight });
          return;
        }
        opts.onWait && opts.onWait(Math.max(0, 60000 - (now - used[0].at)));
        await sleep(Math.min(2000, 60000 - (now - used[0].at) + 50));
      }
    }
    async function info(body, weight = 20) {
      let lastErr;
      for (let attempt = 0; attempt < 5; attempt++) {
        await reserve(weight);
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 20000);
          let res, json;
          try {
            res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
            if (res.ok) json = await res.json();
          } finally {
            clearTimeout(timer);
          }
          if (res.ok) return json;
          lastErr = new Error('Hyperliquid HTTP ' + res.status);
          if (res.status !== 429 && res.status < 500) break;
        } catch (e) {
          lastErr = e;
        }
        await sleep(1000 * 2 ** attempt);
      }
      throw lastErr;
    }
    async function candles(coin, interval, startTime, endTime = Date.now()) {
      const expected = Math.min(MAX_CANDLES, Math.ceil((endTime - startTime) / BASE_MS[interval]) + 1);
      const rows = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(startTime), endTime: Math.floor(endTime) } }, 20 + Math.ceil(expected / 60));
      return (rows || []).map(parseCandle).sort((a, b) => a.t - b.t);
    }
    // With opts.cache, a chart that was already loaded only downloads the newest candles.
    const cache = new Map();
    async function recent(coin, base, start, now) {
      if (!opts.cache) return candles(coin, base, start, now);
      const key = coin + '|' + base, ms = BASE_MS[base];
      const have = cache.get(key);
      const usable = have && have.rows.length && have.from <= start + ms && have.rows[have.rows.length - 1].t > now - (MAX_CANDLES - 1) * ms;
      const fresh = await candles(coin, base, usable ? have.rows[have.rows.length - 1].t : start, now);
      let rows = fresh, from = start;
      if (usable) {
        const byTime = new Map(have.rows.map((r) => [r.t, r]));
        for (const r of fresh) byTime.set(r.t, r);
        rows = [...byTime.values()].sort((a, b) => a.t - b.t);
        from = have.from;
        if (rows.length > MAX_CANDLES) { rows = rows.slice(-MAX_CANDLES); from = rows[0].t; }
      }
      cache.set(key, { rows, from });
      return rows.filter((r) => r.t >= start && r.t <= now);
    }
    // Latest `count` base candles for a chart timeframe, aggregated.
    async function history(coin, tf, count = MAX_CANDLES, now = Date.now()) {
      const base = TIMEFRAMES[tf].base;
      const n = Math.min(MAX_CANDLES, count);
      const raw = await recent(coin, base, now - n * BASE_MS[base], now);
      const bars = aggregate(raw, tf);
      // the oldest bucket may be cut in half by the 5000 limit
      if (bars.length > 1 && tf !== '1W' && tf !== '1M' && bars[0].first !== bars[0].t) bars.shift();
      return bars;
    }
    return { info, candles, history };
  }

  // Auto-reconnecting websocket. Subscriptions are replayed after a reconnect.
  function createStream(opts = {}) {
    const url = opts.url || 'wss://api.hyperliquid.xyz/ws';
    const subs = new Map();
    let ws = null, closed = false, retry = 0, ping = null, lastMsg = 0, timer = null;
    const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

    function connect() {
      if (closed) return;
      const sock = new WebSocket(url);
      ws = sock;
      lastMsg = Date.now();
      sock.onopen = () => {
        retry = 0;
        lastMsg = Date.now();
        for (const s of subs.values()) send({ method: 'subscribe', subscription: s });
        opts.onStatus && opts.onStatus(true);
      };
      sock.onmessage = (ev) => {
        lastMsg = Date.now();
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        opts.onMessage && opts.onMessage(m);
      };
      sock.onerror = () => {};
      sock.onclose = () => drop(sock);
    }
    function drop(sock) {
      if (sock !== ws) return;
      ws = null;
      opts.onStatus && opts.onStatus(false);
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    }
    ping = setInterval(() => {
      if (!ws) return;
      if (Date.now() - lastMsg > 75000) { const s = ws; try { s.close(); } catch {} drop(s); return; }
      send({ method: 'ping' });
    }, 30000);
    connect();
    return {
      subscribe(s) { const k = JSON.stringify(s); if (!subs.has(k)) { subs.set(k, s); send({ method: 'subscribe', subscription: s }); } },
      unsubscribe(s) { const k = JSON.stringify(s); if (subs.delete(k)) send({ method: 'unsubscribe', subscription: s }); },
      close() { closed = true; clearInterval(ping); clearTimeout(timer); ws && ws.close(); },
    };
  }

  Object.assign(KS, { TIMEFRAMES, CHART_TIMEFRAMES, BASE_MS, MAX_CANDLES, bucketStart, bucketEnd, aggregate, parseCandle, coinOf, symbolOf, decimalsFor, fmtPrice, createApi, createStream });
})();
