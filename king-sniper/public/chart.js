// Canvas candlestick chart: pan, zoom, pinch, crosshair, EMAs, trade levels and signal markers.
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const C = { grid: '#1a2130', text: '#7d889c', up: '#26a69a', down: '#ef5350', emaF: '#22d3ee', emaS: '#fb923c', emaT: '#9ca3af', entry: '#9ca3af', sl: '#ef4444', tp: '#22c55e', cross: '#5b6780' };
  const AXIS_W = 76, AXIS_H = 26;

  function createChart(canvas, opts = {}) {
    const g = canvas.getContext('2d');
    let rows = [], W = 0, H = 0, spacing = 8, offset = -6, yZoom = 1, yShift = 0, hover = null, queued = false;
    const show = { ema: true, sessions: true };
    let tfSec = 60;

    const plotW = () => W - AXIS_W;
    const plotH = () => H - AXIS_H;
    // offset = bars between the newest candle and the right edge (negative leaves empty space)
    const xOf = (i) => plotW() - (rows.length - 1 - i + 0.5 - offset) * spacing;
    const iOf = (x) => Math.round(rows.length - 1 + 0.5 - offset - (plotW() - x) / spacing);
    const clampView = () => {
      spacing = Math.max(1.2, Math.min(60, spacing));
      const vis = plotW() / spacing;
      offset = Math.max(-vis * 0.8, Math.min(rows.length - Math.min(10, rows.length), offset));
    };
    const draw = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(); }); } };

    const timeFmt = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hourCycle: 'h23', ...o });
    const fHM = timeFmt({ hour: '2-digit', minute: '2-digit' }), fDM = timeFmt({ day: '2-digit', month: 'short' }), fFull = timeFmt({ weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function niceStep(range, target) {
      const raw = range / target, p = 10 ** Math.floor(Math.log10(raw));
      return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
    }
    function tag(y, text, bg, sub) {
      const h = sub ? 30 : 17;
      g.fillStyle = bg; g.fillRect(plotW() + 1, y - 9, AXIS_W - 2, h);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(text, plotW() + 7, y);
      if (sub) g.fillText(sub, plotW() + 7, y + 13);
    }

    function render() {
      g.clearRect(0, 0, W, H);
      if (!rows.length || W < 50) return;
      clampView();
      const first = Math.max(0, iOf(0) - 1), last = Math.min(rows.length - 1, iOf(plotW()) + 1);
      if (last < first) return;
      let lo = Infinity, hi = -Infinity, vmax = 0;
      for (let i = first; i <= last; i++) { lo = Math.min(lo, rows[i].l); hi = Math.max(hi, rows[i].h); vmax = Math.max(vmax, rows[i].v); }
      // keep the open trade's levels on screen while looking at the latest bars
      const tail = rows[rows.length - 1];
      if (offset < 3) for (const k of ['sl', 'tp3']) if (Number.isFinite(tail[k])) { lo = Math.min(lo, tail[k]); hi = Math.max(hi, tail[k]); }
      const pad = (hi - lo || hi * 0.001) * 0.12;
      const mid = (hi + lo) / 2 + yShift * (hi - lo), half = ((hi - lo) / 2 + pad) * yZoom;
      lo = mid - half; hi = mid + half;
      const top = 24, bottom = plotH() - 6;
      const yOf = (p) => top + ((hi - p) / (hi - lo)) * (bottom - top);
      const pOf = (y) => hi - ((y - top) / (bottom - top)) * (hi - lo);
      g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';

      g.save(); g.beginPath(); g.rect(0, 0, plotW(), plotH()); g.clip();
      if (show.sessions && tfSec < 86400) {
        for (let i = first; i <= last; i++) {
          const s = (rows[i].sess ||= KS.marketSessions(rows[i].t, tfSec));
          for (const [on, col] of [[s.tok, 'rgba(59,130,246,.055)'], [s.lon, 'rgba(249,115,22,.055)'], [s.ny, 'rgba(34,197,94,.055)']])
            if (on) { g.fillStyle = col; g.fillRect(xOf(i) - spacing / 2, 0, spacing + 0.5, plotH()); }
        }
      }
      // grid
      const step = niceStep(hi - lo, Math.max(3, plotH() / 70));
      g.strokeStyle = C.grid; g.lineWidth = 1;
      const priceTicks = [];
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) { priceTicks.push(p); g.beginPath(); g.moveTo(0, Math.round(yOf(p)) + 0.5); g.lineTo(plotW(), Math.round(yOf(p)) + 0.5); g.stroke(); }
      const every = Math.max(1, Math.ceil(90 / spacing));
      const timeTicks = [];
      // anchor labels to bar time so they do not jump while panning
      for (let i = first; i <= last; i++) {
        if (Math.floor(rows[i].t / (tfSec * 1000)) % every) continue;
        const x = Math.round(xOf(i)) + 0.5; timeTicks.push([x, rows[i].t]);
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, plotH()); g.stroke();
      }
      // volume + candles
      const body = Math.max(1, Math.floor(spacing * 0.7));
      for (let i = first; i <= last; i++) {
        const r = rows[i], x = xOf(i), col = r.c >= r.o ? C.up : C.down;
        const vh = vmax ? (r.v / vmax) * plotH() * 0.14 : 0;
        g.globalAlpha = 0.28; g.fillStyle = col; g.fillRect(x - body / 2, plotH() - vh, body, vh); g.globalAlpha = 1;
        g.fillRect(Math.round(x), yOf(r.h), 1, Math.max(1, yOf(r.l) - yOf(r.h)));
        const y1 = yOf(Math.max(r.o, r.c)), y2 = yOf(Math.min(r.o, r.c));
        g.fillRect(Math.round(x - body / 2), y1, body, Math.max(1, y2 - y1));
      }
      const line = (key, color, width, gaps) => {
        g.strokeStyle = color; g.lineWidth = width; g.beginPath();
        let pen = false, prevTrade = null;
        for (let i = first; i <= last; i++) {
          const v = rows[i][key];
          if (!Number.isFinite(v)) { pen = false; continue; }
          const x = xOf(i), y = yOf(v), trade = gaps ? rows[i].entry : null;
          if (gaps) { // trade levels are drawn as steps, one flat piece per bar
            if (pen && trade === prevTrade) g.lineTo(x - spacing / 2, y); else g.moveTo(x - spacing / 2, y);
            g.lineTo(x + spacing / 2, y);
          } else if (pen) g.lineTo(x, y); else g.moveTo(x, y);
          pen = true; prevTrade = trade;
        }
        g.stroke();
      };
      if (show.ema) { line('emaF', C.emaF, 1); line('emaS', C.emaS, 1); line('emaT', C.emaT, 2); }
      line('entry', C.entry, 1, true); line('sl', C.sl, 2, true);
      g.globalAlpha = 0.75; line('tp1', C.tp, 1, true); line('tp2', C.tp, 1, true); g.globalAlpha = 1; line('tp3', C.tp, 2, true);

      // markers
      g.textAlign = 'center';
      for (let i = first; i <= last; i++) {
        const r = rows[i], x = xOf(i);
        let hitUp = 0;
        for (const e of r.events || []) {
          if (e.type === 'BUY' || e.type === 'SELL') {
            const buy = e.type === 'BUY', col = e.flip ? '#9333ea' : buy ? '#16a34a' : '#dc2626';
            const text = (e.flip ? 'FLIP ' : '') + e.type, w = Math.max(30, g.measureText(text).width + 10);
            const tip = buy ? yOf(r.l) + 4 : yOf(r.h) - 4, d = buy ? 1 : -1, boxY = buy ? tip + 6 : tip - 6 - 28;
            g.fillStyle = col; g.beginPath(); g.moveTo(x, tip); g.lineTo(x - 5, tip + 6 * d); g.lineTo(x + 5, tip + 6 * d); g.fill();
            if (spacing >= 3) {
              g.beginPath(); g.roundRect(x - w / 2, boxY, w, 28, 4); g.fill();
              g.fillStyle = '#fff'; g.font = 'bold 11px system-ui, sans-serif'; g.fillText(text, x, boxY + 9);
              g.font = '10px system-ui, sans-serif'; g.fillText(e.conf.toFixed(0) + '%', x, boxY + 20); g.font = '11px system-ui, sans-serif';
            }
          } else {
            const y = yOf(e.price), stop = e.type === 'SL' || e.type === 'TRAIL';
            g.fillStyle = g.strokeStyle = e.type === 'SL' ? C.sl : e.type === 'TRAIL' ? '#f59e0b' : '#4ade80';
            if (stop) { g.lineWidth = 2; g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke(); }
            else { g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.fill(); }
            if (spacing >= 6) g.fillText(e.type, x, y - 11 - 11 * hitUp++);
          }
        }
      }
      g.restore();

      // axes
      g.strokeStyle = '#2a3346'; g.lineWidth = 1; g.beginPath(); g.moveTo(plotW() + 0.5, 0); g.lineTo(plotW() + 0.5, H); g.moveTo(0, plotH() + 0.5); g.lineTo(W, plotH() + 0.5); g.stroke();
      g.fillStyle = C.text; g.textAlign = 'left';
      for (const p of priceTicks) g.fillText(KS.fmtPrice(p), plotW() + 7, yOf(p));
      g.textAlign = 'center';
      let lastX = -99;
      for (const [x, t] of timeTicks) {
        if (x - lastX < 56 || x > plotW() - 20 || x < 20) continue;
        const hm = fHM.format(t);
        g.fillText(tfSec >= 86400 || hm === '00:00' ? fDM.format(t) : hm, x, plotH() + 13); lastX = x;
      }
      // open-trade price tags
      if (Number.isFinite(tail.entry)) for (const [k, label, col] of [['tp3', 'TP3', '#15803d'], ['tp2', 'TP2', '#15803d'], ['tp1', 'TP1', '#15803d'], ['entry', 'IN', '#4b5563'], ['sl', 'SL', '#b91c1c']]) {
        const y = yOf(tail[k]); if (y > 8 && y < plotH() - 8) tag(y, label + ' ' + KS.fmtPrice(tail[k]), col);
      }
      // last price + countdown
      const ly = Math.max(10, Math.min(plotH() - 24, yOf(tail.c))), col = tail.c >= tail.o ? C.up : C.down;
      g.setLineDash([2, 3]); g.strokeStyle = col; g.beginPath(); g.moveTo(0, yOf(tail.c)); g.lineTo(plotW(), yOf(tail.c)); g.stroke(); g.setLineDash([]);
      const left = Math.max(0, Math.floor((KS.bucketEnd(tail.t, api.tf) - Date.now()) / 1000));
      const dd = Math.floor(left / 86400), hh = Math.floor((left % 86400) / 3600), mm = Math.floor((left % 3600) / 60), ss = left % 60, p2 = (n) => String(n).padStart(2, '0');
      tag(ly, KS.fmtPrice(tail.c), col, dd ? `${dd}d ${hh}h` : (hh ? hh + ':' : '') + p2(mm) + ':' + p2(ss));
      // crosshair
      let hoverRow = null;
      if (hover && hover.x < plotW() && hover.y < plotH()) {
        const i = Math.max(0, Math.min(rows.length - 1, iOf(hover.x))), x = Math.round(xOf(i)) + 0.5;
        hoverRow = rows[i];
        g.setLineDash([4, 4]); g.strokeStyle = C.cross; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, plotH()); g.moveTo(0, hover.y + 0.5); g.lineTo(plotW(), hover.y + 0.5); g.stroke(); g.setLineDash([]);
        tag(hover.y, KS.fmtPrice(pOf(hover.y)), '#374151');
        const label = fFull.format(rows[i].t) + ' PHT', w = g.measureText(label).width + 14, bx = Math.max(0, Math.min(plotW() - w, x - w / 2));
        g.fillStyle = '#374151'; g.fillRect(bx, plotH() + 3, w, 19); g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(label, bx + w / 2, plotH() + 13);
      }
      opts.onHover && opts.onHover(hoverRow || tail);
    }

    // ───── input ─────
    const pointers = new Map();
    let drag = null, pinch = null;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e); pointers.set(e.pointerId, p); hover = p;
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, spacing }; drag = null; }
      else drag = { ...p, offset, yShift, yZoom, axis: p.x > plotW() };
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pos(e); if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p); hover = p;
      if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; spacing = pinch.spacing * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d); }
      else if (drag) {
        if (drag.axis) yZoom = Math.max(0.2, Math.min(8, drag.yZoom * Math.exp((p.y - drag.y) / 200)));
        else { offset = drag.offset + (p.x - drag.x) / spacing; if (yZoom !== 1 || drag.yShift) yShift = drag.yShift + ((p.y - drag.y) / plotH()) * yZoom; }
      }
      draw();
    });
    const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; drag = null; if (e.pointerType === 'touch' && !pointers.size) hover = null; draw(); };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; draw(); } });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) offset -= e.deltaX / spacing;
      else {
        const before = (plotW() - p.x) / spacing;
        spacing = Math.max(1.2, Math.min(60, spacing * Math.exp(-e.deltaY * 0.0015)));
        offset += before - (plotW() - p.x) / spacing; // keep the bar under the cursor still
      }
      draw();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => { yZoom = 1; yShift = 0; draw(); });

    new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect(), d = globalThis.devicePixelRatio || 1;
      W = r.width; H = r.height; canvas.width = Math.round(W * d); canvas.height = Math.round(H * d); g.setTransform(d, 0, 0, d, 0, 0); render();
    }).observe(canvas);
    setInterval(draw, 1000);

    const api = {
      tf: '15m',
      show,
      draw,
      reset(newRows, tf) { rows = newRows; api.tf = tf; tfSec = KS.TIMEFRAMES[tf].sec; spacing = W < 600 ? 6 : 9; offset = -8; yZoom = 1; yShift = 0; hover = null; draw(); },
      // keep the same candles in view when the user has scrolled back and new bars arrive
      update(newRows) { if (offset > 0 && newRows.length > rows.length) offset += newRows.length - rows.length; rows = newRows; draw(); },
      latest() { offset = -8; yZoom = 1; yShift = 0; draw(); },
    };
    return api;
  }
  KS.createChart = createChart;
})();
