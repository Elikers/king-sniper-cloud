// Page logic: markets, timeframes, live data from Hyperliquid, side panel, settings.
(function () {
  const KS = globalThis.KS;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
  const store = {
    get(k, def) { try { const v = JSON.parse(localStorage.getItem('ks.' + k)); return v === null ? def : v; } catch { return def; } },
    set(k, v) { try { localStorage.setItem('ks.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const DEFAULT_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC'];

  let coins = store.get('coins', DEFAULT_COINS);
  let coin = store.get('coin', 'BTC');
  let tf = store.get('tf', '15m');
  if (!KS.CHART_TIMEFRAMES.includes(tf)) tf = '15m';
  let tab = 'signal';
  let overrides = store.get('settings', {});
  let serverSettings = {}, serverStatus = null;
  const settings = () => ({ ...serverSettings, ...overrides });

  const api = KS.createApi({
    cache: true,
    onWait: (ms) => { if (!$('overlay').hidden && !$('retry')) $('overlay').textContent = `Hyperliquid rate limit reached, continuing in about ${Math.ceil(ms / 1000)}s…`; },
  });
  const quotes = {};
  let session = null; // everything belonging to the chart currently on screen
  let stream = null;

  const chart = KS.createChart($('chart'), { onHover: legend });
  chart.show.ema = store.get('ema', true);
  chart.show.sessions = store.get('sess', true);

  // ───────────── chart data ─────────────
  const overlay = (html) => { $('overlay').hidden = !html; $('overlay').innerHTML = html || ''; };

  async function load() {
    if (session) stream.unsubscribe(session.sub);
    const s = (session = { coin, tf, base: KS.TIMEFRAMES[tf].base, engine: null, closed: [], live: new Map(), liveRow: null, nextTime: 0, syncing: false, dirty: false, lastSync: 0 });
    s.sub = { type: 'candle', coin: s.coin, interval: s.base };
    chart.reset([], tf);
    $('legend').innerHTML = ''; $('panel').dataset.empty = '1'; renderPanel();
    overlay(`Loading ${esc(KS.symbolOf(s.coin))} ${s.tf} from Hyperliquid…`);
    try {
      const now = Date.now(); // taken before the download so an unfinished candle is never treated as closed
      const { engine, bars } = await KS.bootstrap(api, s.coin, s.tf, settings(), { now });
      if (session !== s) return;
      if (!bars.length) throw new Error('No candles for this market.');
      const closed = bars.filter((b) => KS.bucketEnd(b.t, s.tf) <= now);
      s.engine = engine;
      for (const b of closed) s.closed.push(engine.step(b));
      s.nextTime = closed.length ? KS.bucketEnd(closed[closed.length - 1].t, s.tf) : bars[0].t;
      stream.subscribe(s.sub);
      await sync(s); // pick up the forming bar piece by piece
      if (session !== s) return;
      chart.reset(allRows(s), s.tf);
      overlay('');
      $('info').textContent = `${bars.length} bars · higher timeframe ${engine.cfg.htfTf} · times in PHT`;
      renderPanel();
    } catch (e) {
      if (session !== s) return;
      overlay(`<b>Could not load market data</b><span class="mute">${esc(e.message)}</span><button id="retry" type="button">Try again</button>`);
      $('retry').onclick = load;
    }
  }

  const allRows = (s) => (s.liveRow ? [...s.closed, s.liveRow] : s.closed);

  // Fetch finished candles from the REST API (authoritative), then rebuild the forming bar.
  async function sync(s) {
    if (s.syncing || !s.engine) return;
    s.syncing = true; s.lastSync = Date.now();
    try {
      const baseMs = KS.BASE_MS[s.base];
      const now = Date.now();
      const raw = await api.candles(s.coin, s.base, s.nextTime, now);
      if (session !== s) return;
      for (const b of KS.aggregate(raw, s.tf)) {
        if (b.t < s.nextTime) continue;
        const end = KS.bucketEnd(b.t, s.tf);
        if (end + 2000 > now || (b.last < end - baseMs && now < end + 30000)) break;
        if (!s.engine.htfReady(b.t)) {
          await s.engine.syncHtf(api, s.coin, now);
          if (session !== s) return;
          if (!s.engine.htfReady(b.t) && now < end + 60000) break;
        }
        s.closed.push(s.engine.step(b));
        s.nextTime = end;
      }
      if (!s.engine.htfReady(s.nextTime)) await s.engine.syncHtf(api, s.coin, now);
      if (session !== s) return;
      for (const k of raw) { const have = s.live.get(k.t); if (!have || k.v >= have.v) s.live.set(k.t, k); }
      for (const t of s.live.keys()) if (t < s.nextTime) s.live.delete(t);
      s.dirty = true;
      repaint();
    } finally { s.syncing = false; }
  }

  // Run the forming bar through a throw-away copy of the engine (like Pine on a live bar).
  function repaint() {
    const s = session;
    if (!s?.engine || !s.dirty) return;
    s.dirty = false;
    const pieces = [...s.live.values()].filter((k) => k.t >= s.nextTime).sort((a, b) => a.t - b.t);
    const bars = KS.aggregate(pieces, s.tf);
    s.liveRow = null;
    if (bars.length) {
      const copy = KS.createEngine(settings(), s.tf, { state: KS.loadState(KS.saveState(s.engine.state)) });
      s.liveRow = copy.step(bars[0], false);
      s.view = copy;
    } else s.view = s.engine;
    chart.update(allRows(s));
    renderPanel();
  }
  setInterval(repaint, 500);
  setInterval(() => {
    const s = session;
    if (!s?.engine || Date.now() - s.lastSync < 5000) return;
    const due = Date.now() >= KS.bucketEnd(s.nextTime, s.tf) + 2500;
    if (due) sync(s).catch(() => {});
  }, 1000);

  function onMessage(m) {
    if (m.channel === 'allMids') {
      for (const [k, v] of Object.entries(m.data.mids)) if (quotes[k]) quotes[k].price = +v; else quotes[k] = { price: +v };
    } else if (m.channel === 'candle') {
      for (const c of [].concat(m.data)) {
        const s = session;
        if (!s || c.s !== s.coin || c.i !== s.base || +c.t < s.nextTime) continue;
        const k = KS.parseCandle(c);
        s.live.set(k.t, k); s.dirty = true;
        if (quotes[c.s]) quotes[c.s].price = k.c;
      }
    }
  }

  // ───────────── legend + side panel ─────────────
  function legend(r) {
    if (!r || !session) return;
    const cls = r.c >= r.o ? 'up' : 'down', chg = ((r.c - r.o) / r.o) * 100;
    const p = KS.fmtPrice;
    let html = `<span><b>${esc(KS.symbolOf(session.coin))}</b> · ${session.tf} · Hyperliquid</span>` +
      ['o', 'h', 'l', 'c'].map((k) => `<span>${k.toUpperCase()} <b class="${cls}">${p(r[k])}</b></span>`).join('') +
      `<span class="${cls}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span><span class="mute">Vol ${r.v.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`;
    if (chart.show.ema) html += `<br><span style="color:#22d3ee">EMA fast ${p(r.emaF)}</span><span style="color:#fb923c">EMA slow ${p(r.emaS)}</span><span style="color:#9ca3af">EMA trend ${p(r.emaT)}</span>`;
    for (const e of r.events || []) html += `<br><span><b>${e.flip ? 'FLIP ' : ''}${e.type}</b> @ ${p(e.price)}${e.sl && e.conf !== undefined ? ` · SL ${p(e.sl)} · TP ${p(e.tp1)} / ${p(e.tp2)} / ${p(e.tp3)} · ${e.conf}% (${e.score}/12)` : e.closed ? ` · result ${num(e.tradeR)}R` : ''}</span>`;
    if ($('legend').innerHTML !== html) $('legend').innerHTML = html;
  }

  const pill = (ok, text) => `<span class="pill ${ok ? 'ok' : 'no'}">${text ?? (ok ? '✔' : '✘')}</span>`;
  let panelHtml = '';
  function renderPanel() {
    const s = session, eng = s?.view, row = s && (s.liveRow || s.closed[s.closed.length - 1]);
    let h = '';
    if (tab === 'alerts') h = alertsPanel();
    else if (!eng || !row) h = '<p class="mute">Waiting for data…</p>';
    else {
      const c = eng.cfg, st = eng.stats(), p = KS.fmtPrice;
      if (tab === 'signal') {
        if (st.dir) h += `<div class="card"><h3 class="${st.dir === 1 ? 'up' : 'down'}">${st.position} · ${st.stage}</h3><div class="levels"><span>Entry</span><b>${p(st.entry)}</b><span>Stop / trail</span><b class="down">${p(st.sl)}</b><span>TP1</span><b>${p(st.tp1)}</b><span>TP2</span><b>${p(st.tp2)}</b><span>TP3</span><b>${p(st.tp3)}</b><span>Size @ ${c.riskPct}% risk</span><b>${num(st.qty, 4)} ≈ ${num(st.notional)} USDC</b></div></div>`;
        else h += `<div class="card"><h3>FLAT</h3><span class="mute">${st.paused ? 'Entries are paused by drawdown protection.' : 'Waiting for the next signal. Signals confirm when a bar closes.'}</span></div>`;
        h += '<table class="filters"><tr><th>Filter</th><th>LONG</th><th>SHORT</th></tr>' +
          KS.FILTER_NAMES.map((n, i) => `<tr${c['u' + (i + 1)] ? '' : ' class="mute" title="Switched off"'}><td>${i + 1} ${n}${c['u' + (i + 1)] ? '' : ' (off)'}</td><td>${pill(row.filtersL[i])}</td><td>${pill(row.filtersS[i])}</td></tr>`).join('') +
          `<tr><td><b>Score (need ${c.minPass})</b></td><td>${pill(row.scoreL >= c.minPass, row.scoreL + '/12')}</td><td>${pill(row.scoreS >= c.minPass, row.scoreS + '/12')}</td></tr></table>`;
      } else if (tab === 'stats') {
        const line = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
        h = '<table class="stats">' + line('Mode', esc(c.mode)) + line('Higher timeframe', c.htfTf) + line('Entries', pill(!st.paused, st.paused ? 'PAUSED' : 'ACTIVE')) +
          line('Simulated trades', st.trades) + line('Win rate', Number.isFinite(st.winRate) ? num(st.winRate, 1) + '%' : '-') + line('Net R', num(st.netR)) +
          line('Profit factor', num(st.profitFactor)) + line('Avg win / avg loss', `+${num(st.avgWin)}R / -${num(st.avgLoss)}R`) +
          line('Max drawdown / target', `${num(st.maxDD, 1)}% / ${num(c.ddTarget, 1)}%`) + line('Worst streak', num(st.maxDDR, 1) + 'R') +
          line('Suggested risk', Number.isFinite(st.suggestedRisk) ? num(st.suggestedRisk) + '%' : '-') +
          line('Last entry confidence', Number.isFinite(st.lastConf) ? st.lastConf + '%' : '-') +
          line('Past win rate at that score', `${Number.isFinite(st.lastWR) ? num(st.lastWR, 0) + '%' : 'n/a'} (n=${st.lastN})`) +
          '</table><p class="mute">Calculated over the loaded history only, before fees, slippage and funding. TradingView may load a different amount of history, so totals can differ.</p>';
      } else {
        const cur = KS.phtHour(Date.now());
        const best = st.hours.filter((x) => x.avgR > 0).sort((a, b) => b.avgR - a.avgR).slice(0, 3).map((x) => String(x.hour).padStart(2, '0') + ':00');
        h = `<div class="card"><h3>Best PHT hours</h3>${best.length ? best.join(' · ') : `Learning (needs ${c.minHourTrades}+ trades in an hour)`}</div><div class="heat">` +
          st.hours.map((x) => `<div class="${Number.isFinite(x.avgR) ? (x.avgR > 0 ? 'g' : 'r') : ''}${x.hour === cur ? ' now' : ''}" title="Trades ${x.trades} · wins ${x.wins} · net ${num(x.netR)}R">${String(x.hour).padStart(2, '0')}:00<br>${Number.isFinite(x.avgR) ? num(x.avgR) + 'R' : '-'}</div>`).join('') +
          '</div><p class="mute">Average result per trade by the Philippine hour the trade was opened. Gold outline = now.</p>';
      }
    }
    if (h !== panelHtml) { panelHtml = h; $('panel').innerHTML = h; }
  }

  function alertsPanel() {
    const s = serverStatus;
    if (!s) return '<div class="card"><h3>Alert server not connected</h3>Discord alerts are sent by the King Sniper server, not by this page. Start it (see README) and open the website from its address to see alert status here.</div>';
    const when = (t) => new Date(t).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const ready = s.streams.filter((x) => x.ready).length;
    let h = `<div class="card"><h3>Discord alerts</h3>${pill(s.discord.configured && !s.discord.lastError, !s.discord.configured ? 'NO WEBHOOK' : s.discord.lastError ? 'ERROR' : 'READY')} ${esc(s.discord.lastError)}<br>
      Watching ${ready}/${s.streams.length} charts: ${esc(s.timeframes.join(', '))}<br><span class="mute">${esc(s.symbols.join(', '))}</span><br>
      TP/SL timing: ${s.tpSlAlerts === 'close' ? 'at bar close' : 'as price touches'} · Live feed ${s.websocket ? 'on' : 'off'}${s.discord.lastSentAt ? `<br>Last message ${when(s.discord.lastSentAt)}` : ''}</div>`;
    const errs = s.streams.filter((x) => x.error);
    if (errs.length) h += `<div class="card down">${errs.slice(0, 5).map((x) => esc(`${x.symbol} ${x.tf}: ${x.error}`)).join('<br>')}</div>`;
    const open = s.streams.filter((x) => x.position && x.position !== 'FLAT');
    if (open.length) h += '<table><tr><th>Open on server</th><th>Side</th><th>Entry</th><th>Stop</th></tr>' + open.map((x) => `<tr><td>${esc(x.symbol.replace('USDC.P', ''))} ${esc(x.tf)}</td><td class="${x.position === 'LONG' ? 'up' : 'down'}">${esc(x.position)}</td><td>${KS.fmtPrice(x.entry)}</td><td>${KS.fmtPrice(x.sl)}</td></tr>`).join('') + '</table>';
    h += '<h3>Recent alerts</h3>' + (s.recent.length ? s.recent.map((a) => `<div class="alert"><span><b class="${a.type === 'BUY' || a.type.startsWith('TP') ? 'up' : 'down'}">${a.flip ? 'FLIP ' : ''}${esc(a.type)}</b> ${esc(a.symbol)} ${esc(a.tf)} @ ${KS.fmtPrice(a.price)}</span><span class="mute">${when(a.at)}</span></div>`).join('') : '<p class="mute">None yet. Alerts appear here when a new signal fires.</p>');
    return h;
  }

  async function pollServer(first) {
    if (!location.protocol.startsWith('http')) return;
    try {
      const res = await fetch('api/status', { cache: 'no-store' });
      serverStatus = res.ok ? await res.json() : null;
      if (first && serverStatus) serverSettings = serverStatus.settings;
    } catch { serverStatus = null; }
    if (tab === 'alerts') renderPanel();
  }

  // ───────────── markets + timeframes ─────────────
  function renderWatch() {
    const el = $('watch');
    if (el.childElementCount !== coins.length || [...el.children].some((b, i) => b.dataset.coin !== coins[i])) {
      el.innerHTML = coins.map((c) => `<button type="button" class="mkt" data-coin="${esc(c)}"><b>${esc(KS.symbolOf(c))}</b><span></span><em></em>${DEFAULT_COINS.includes(c) ? '' : '<i title="Remove">×</i>'}</button>`).join('');
    }
    for (const b of el.children) {
      const q = quotes[b.dataset.coin] || {}, chg = q.prev ? ((q.price - q.prev) / q.prev) * 100 : NaN;
      b.classList.toggle('on', b.dataset.coin === coin);
      b.querySelector('span').textContent = KS.fmtPrice(q.price);
      const em = b.querySelector('em');
      em.textContent = Number.isFinite(chg) ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '';
      em.className = chg >= 0 ? 'up' : 'down';
    }
    const q = quotes[coin];
    document.title = q?.price ? `${KS.fmtPrice(q.price)} ${coin} · King Sniper` : 'King Sniper · Hyperliquid charts';
  }
  async function loadQuotes() {
    try {
      const [meta, ctx] = await api.info({ type: 'metaAndAssetCtxs' });
      meta.universe.forEach((u, i) => { quotes[u.name] = { price: +(ctx[i].midPx || ctx[i].markPx), prev: +ctx[i].prevDayPx }; });
      if (!$('allCoins').childElementCount) $('allCoins').innerHTML = meta.universe.filter((u) => !u.isDelisted).map((u) => `<option value="${esc(KS.symbolOf(u.name))}">`).join('');
      renderWatch();
    } catch { /* the websocket still updates prices */ }
  }
  $('watch').onclick = (e) => {
    const b = e.target.closest('.mkt'); if (!b) return;
    if (e.target.tagName === 'I') {
      coins = coins.filter((c) => c !== b.dataset.coin); store.set('coins', coins);
      if (coin === b.dataset.coin) { coin = coins[0]; store.set('coin', coin); load(); }
    } else if (coin !== b.dataset.coin) { coin = b.dataset.coin; store.set('coin', coin); load(); }
    renderWatch();
  };
  const addMarket = () => {
    const typed = KS.coinOf($('addInput').value).toUpperCase();
    const match = Object.keys(quotes).find((k) => k.toUpperCase() === typed);
    if (!match) return false;
    if (!coins.includes(match)) coins.push(match);
    coin = match; store.set('coins', coins); store.set('coin', coin); $('addInput').value = ''; renderWatch(); load();
    return true;
  };
  $('addForm').onsubmit = (e) => { e.preventDefault(); if (!addMarket()) { $('addInput').setCustomValidity('Not a Hyperliquid perpetual'); $('addInput').reportValidity(); } };
  $('addInput').oninput = (e) => { e.target.setCustomValidity(''); if (e.inputType === 'insertReplacementText' || e.inputType === undefined) addMarket(); };

  $('tfs').innerHTML = KS.CHART_TIMEFRAMES.map((t) => `<button type="button" data-tf="${t}">${t}</button>`).join('');
  const markTf = () => { for (const b of $('tfs').children) { b.classList.toggle('on', b.dataset.tf === tf); b.setAttribute('aria-pressed', b.dataset.tf === tf); } };
  $('tfs').onclick = (e) => { const t = e.target.dataset.tf; if (t && t !== tf) { tf = t; store.set('tf', tf); markTf(); load(); } };

  document.querySelector('.tabs').onclick = (e) => {
    if (!e.target.dataset.tab) return;
    tab = e.target.dataset.tab;
    for (const b of e.currentTarget.children) b.classList.toggle('on', b === e.target);
    renderPanel(); if (tab === 'alerts') pollServer();
  };
  const toggle = (id, key, storeKey) => {
    const b = $(id); b.classList.toggle('on', chart.show[key]);
    b.onclick = () => { chart.show[key] = !chart.show[key]; store.set(storeKey, chart.show[key]); b.classList.toggle('on', chart.show[key]); chart.draw(); };
  };
  toggle('tEma', 'ema', 'ema'); toggle('tSess', 'sessions', 'sess');
  $('bLatest').onclick = () => chart.latest();

  // ───────────── settings + Pine source ─────────────
  $('bSettings').onclick = () => {
    const cur = { ...KS.DEFAULTS, ...settings() };
    const groups = [...new Set(KS.SCHEMA.map((f) => f.group))];
    $('settingsBody').innerHTML = groups.map((g) => `<fieldset><legend>${g}</legend>` + KS.SCHEMA.filter((f) => f.group === g).map((f) => {
      const v = cur[f.key];
      const input = f.options ? `<select name="${f.key}">${f.options.map((o) => `<option${o === v ? ' selected' : ''}>${o}</option>`).join('')}</select>`
        : typeof f.def === 'boolean' ? `<input type="checkbox" name="${f.key}"${v ? ' checked' : ''}>`
        : `<input name="${f.key}" type="${typeof f.def === 'number' ? 'number' : 'text'}" step="any" value="${esc(v)}">`;
      return `<label><span>${esc(f.label)}</span>${input}</label>`;
    }).join('') + '</fieldset>').join('');
    $('settingsDlg').returnValue = '';
    $('settingsDlg').showModal();
  };
  $('settingsDlg').addEventListener('close', () => {
    const dlg = $('settingsDlg');
    if (dlg.returnValue === 'reset') overrides = {};
    else if (dlg.returnValue === 'apply') {
      const form = dlg.querySelector('form'), base = { ...KS.DEFAULTS, ...serverSettings };
      overrides = {};
      for (const f of KS.SCHEMA) {
        const el = form.elements[f.key];
        let v = typeof f.def === 'boolean' ? el.checked : el.value;
        if (typeof f.def === 'number') {
          v = el.value === '' || !Number.isFinite(+el.value) ? base[f.key] : +el.value;
          if (/L$|Len$/.test(f.key)) v = Math.max(1, Math.min(1000, Math.round(v))); // indicator lengths
        }
        if (v !== base[f.key]) overrides[f.key] = v;
      }
    } else return;
    store.set('settings', overrides); load();
  });
  async function pineSource() {
    if (globalThis.KS_PINE) return globalThis.KS_PINE;
    const res = await fetch('indicator.pine');
    if (!res.ok) throw new Error('not found');
    return res.text();
  }
  $('bPine').onclick = async () => {
    $('pineDlg').showModal();
    try { $('pineText').value = await pineSource(); } catch { $('pineText').value = 'Open indicator/king_sniper_smart_filter.pine in the project folder.'; }
  };
  $('bCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('pineText').value); } catch { $('pineText').select(); document.execCommand('copy'); }
    $('bCopy').textContent = 'Copied'; setTimeout(() => ($('bCopy').textContent = 'Copy code'), 1500);
  };

  // ───────────── start ─────────────
  stream = KS.createStream({
    onMessage,
    onStatus: (up) => {
      $('conn').textContent = up ? 'Live: Hyperliquid' : 'Reconnecting…';
      $('conn').className = 'dot' + (up ? ' live' : '');
      if (up && session?.engine) sync(session).catch(() => {});
    },
  });
  stream.subscribe({ type: 'allMids' });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && session?.engine) sync(session).catch(() => {}); });
  (async () => {
    markTf(); renderWatch(); loadQuotes();
    await pollServer(true);
    load();
    setInterval(loadQuotes, 20000);
    setInterval(renderWatch, 1000);
    setInterval(pollServer, 10000);
  })();
})();
