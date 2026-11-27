// Discord webhook: message formatting and a retrying, rate-limit aware sender.
import '../public/shared/market.js';
const KS = globalThis.KS;
const px = KS.fmtPrice;
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');

const STYLE = {
  BUY: { color: 0x16a34a, icon: '🟢', title: 'BUY' },
  SELL: { color: 0xdc2626, icon: '🔴', title: 'SELL' },
  TP1: { color: 0x22c55e, icon: '🎯', title: 'TP1 HIT' },
  TP2: { color: 0x22c55e, icon: '🎯🎯', title: 'TP2 HIT' },
  TP3: { color: 0x15803d, icon: '🏆', title: 'TP3 HIT (trade closed)' },
  SL: { color: 0x991b1b, icon: '🛑', title: 'STOP LOSS HIT' },
  TRAIL: { color: 0xf59e0b, icon: '🔒', title: 'TRAILING STOP HIT' },
};
const when = (t) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(t) + ' PHT';
const field = (name, value, inline = true) => ({ name, value: String(value), inline });
const move = (e, price) => {
  const pct = ((price - e.entry) / e.entry) * 100 * e.dir;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
};

export function embedFor({ event: e, symbol, tf, mode, late }) {
  const st = STYLE[e.type];
  const side = e.dir === 1 ? 'LONG' : 'SHORT';
  const entry = e.type === 'BUY' || e.type === 'SELL';
  const flip = e.flip ? 'FLIP ' : '';
  const embed = {
    color: e.flip ? 0x9333ea : st.color,
    title: `${st.icon} ${flip}${st.title} · ${symbol} · ${tf}`,
    timestamp: new Date(e.sentAt || Date.now()).toISOString(),
    footer: { text: `King Sniper Smart Filter · ${mode} · bar ${when(e.barTime)}${late ? ' · DELAYED ALERT' : ''}` },
  };
  if (entry) {
    const wr = Number.isFinite(e.winRate) ? `${e.winRate.toFixed(0)}% (n=${e.n})` : `n/a (n=${e.n})`;
    embed.fields = [
      field('Entry', px(e.entry)), field('Stop loss', `${px(e.sl)} (${move(e, e.sl)})`), field('Side', side),
      field('TP1', `${px(e.tp1)} (${move(e, e.tp1)})`), field('TP2', `${px(e.tp2)} (${move(e, e.tp2)})`), field('TP3', `${px(e.tp3)} (${move(e, e.tp3)})`),
      field('Confidence', `${num(e.conf, 0)}% · ${e.score}/12`), field('Past win rate', wr), field('Size (risk calc)', `${num(e.qty, 4)} ≈ ${num(e.notional)} USDC`),
    ];
  } else {
    embed.fields = [field('Side', side), field('Entry', px(e.entry)), field(e.type.startsWith('TP') ? 'Target' : 'Stop', `${px(e.price)} (${move(e, e.price)})`)];
    if (e.closed) embed.fields.push(field('Trade result', `${e.tradeR >= 0 ? '+' : ''}${num(e.tradeR)}R (before fees)`));
    else if (Number.isFinite(e.newStop)) embed.fields.push(field('Stop now', px(e.newStop)));
  }
  return embed;
}

export function createSender({ webhookUrl, queue = [], onChange = () => {}, onExpire = () => {}, log = console.log, now = () => Date.now() }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = { configured: /^https?:\/\//.test(webhookUrl || ''), lastSentAt: 0, lastError: '' };
  let running = null;

  async function post(payload) {
    const url = new URL(webhookUrl);
    url.searchParams.set('wait', 'true');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true };
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      return { retryMs: Math.ceil((body.retry_after || 2) * 1000) + 250, error: 'rate limited' };
    }
    if (res.status >= 500) return { retryMs: 5000, error: 'Discord HTTP ' + res.status };
    return { fatal: true, error: `Discord rejected the message (HTTP ${res.status}). ${res.status === 401 || res.status === 404 ? 'Check DISCORD_WEBHOOK_URL: the webhook may be deleted or wrong.' : ''}` };
  }

  // Checked before every attempt: old entry signals are dropped (with their exits), old exits are marked.
  function prune() {
    const t = now(), dead = new Set();
    for (const item of queue) item.meta?.forEach((m) => { if (m?.entry && t > m.deadline) dead.add(m.trade); });
    for (let q = queue.length - 1; q >= 0; q--) {
      const item = queue[q], meta = item.meta || [];
      const keep = item.payload.embeds.map((embed, i) => {
        const m = meta[i];
        if (m && dead.has(m.trade)) return null;
        if (m && t > m.deadline && !embed.footer.text.includes('DELAYED')) embed.footer.text += ' · DELAYED ALERT';
        return { embed, m };
      }).filter(Boolean);
      if (!keep.length || t - item.at > 3600000) { queue.splice(q, 1); continue; }
      item.payload.embeds = keep.map((k) => k.embed);
      item.meta = keep.map((k) => k.m);
    }
    for (const trade of dead) { onExpire(trade); log('[discord] dropped an expired signal ' + trade); }
  }

  async function drain() {
    let attempt = 0;
    for (;;) {
      prune();
      if (!queue.length) { onChange(); return; }
      const item = queue[0];
      let r;
      try { r = await post(item.payload); } catch (e) { r = { retryMs: Math.min(60000, 2000 * 2 ** attempt), error: 'network: ' + (e.cause?.code || e.name) }; }
      if (r.ok) { queue.shift(); attempt = 0; status.lastSentAt = now(); status.lastError = ''; log('[discord] delivered ' + item.payload.embeds.length + ' embed(s)'); onChange(); continue; }
      status.lastError = r.error;
      log('[discord] ' + r.error);
      if (r.fatal) { queue.shift(); attempt = 0; onChange(); continue; } // Discord refuses it: retrying cannot help
      attempt++;
      await sleep(r.retryMs);
    }
  }

  function flush() {
    if (!status.configured) return Promise.resolve();
    running ||= drain().finally(() => { running = null; if (queue.length) flush(); });
    return running;
  }
  function send(embeds, meta = []) {
    if (!status.configured) { status.lastError = 'DISCORD_WEBHOOK_URL is not set'; return Promise.resolve(); }
    for (let i = 0; i < embeds.length; i += 10) {
      queue.push({ at: now(), meta: meta.slice(i, i + 10), payload: { username: 'King Sniper', allowed_mentions: { parse: [] }, embeds: embeds.slice(i, i + 10) } });
    }
    onChange();
    return flush();
  }
  return { send, flush, status, queue };
}
