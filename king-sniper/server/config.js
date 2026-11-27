// Shared by the always-on server (index.js), the run-once mode (run-once.js) and the market editor (markets.js).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import '../public/shared/market.js';
import '../public/shared/engine.js';
const KS = globalThis.KS;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SYMBOLS_FILE = join(ROOT, 'symbols.txt');

export function loadEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env is optional */ }
}

// symbols.txt: one market per line, "#" starts a comment. Accepts DOGE, DOGEUSDC.P, HYPERLIQUID:DOGEUSDC.P ...
export function parseSymbols(text) {
  return String(text).split(/\r?\n|,/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}
export function readSymbolsFile(file = SYMBOLS_FILE) {
  return existsSync(file) ? parseSymbols(readFileSync(file, 'utf8')) : [];
}

export function loadConfig() {
  const config = JSON.parse(readFileSync(process.env.KS_CONFIG || join(ROOT, 'config.json'), 'utf8'));
  const bad = config.timeframes.filter((t) => !KS.CHART_TIMEFRAMES.includes(t));
  if (bad.length) throw new Error(`config.json: unknown timeframe(s) ${bad.join(', ')}. Use: ${KS.CHART_TIMEFRAMES.join(', ')}`);
  const unknown = Object.keys(config.settings || {}).filter((k) => !(k in KS.DEFAULTS));
  if (unknown.length) throw new Error(`config.json: unknown setting(s) ${unknown.join(', ')}`);
  // markets come from symbols.txt (easy to edit) plus anything still listed in config.json
  const all = [...readSymbolsFile(process.env.KS_SYMBOLS || SYMBOLS_FILE), ...(config.symbols || [])];
  config.symbols = [...new Set(all)];
  if (!config.symbols.length) throw new Error('No markets to watch. Add one per line to symbols.txt, for example BTCUSDC.P');
  return config;
}

// Hyperliquid's list of perpetual markets (name -> real spelling, e.g. "kpepe" -> "kPEPE").
export async function fetchUniverse(api) {
  const meta = await api.info({ type: 'meta' });
  const names = (meta?.universe || []).filter((u) => !u.isDelisted).map((u) => u.name);
  if (!names.length) throw new Error('empty market list');
  return names;
}

// Fixes capitalisation, drops duplicates and separates names Hyperliquid does not list.
// If the list cannot be downloaded the names are used as typed, so a Hyperliquid hiccup never blocks alerts.
export async function resolveSymbols(api, symbols) {
  let names;
  try { names = await fetchUniverse(api); } catch (e) { return { ok: [...new Set(symbols)], bad: [], unchecked: true, error: e.message }; }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const ok = [], bad = [];
  for (const raw of symbols) {
    const real = byLower.get(KS.coinOf(raw).toLowerCase());
    if (!real) bad.push(raw);
    else if (!ok.includes(KS.symbolOf(real))) ok.push(KS.symbolOf(real));
  }
  return { ok, bad, unchecked: false };
}
