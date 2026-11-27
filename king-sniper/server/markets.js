// Add or remove markets in symbols.txt, checking each name against Hyperliquid first.
//   node server/markets.js add DOGE kPEPE        node server/markets.js remove DOGE        node server/markets.js list
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import '../public/shared/market.js';
import { SYMBOLS_FILE, parseSymbols, resolveSymbols } from './config.js';
const KS = globalThis.KS;

const [cmd = 'list', ...rest] = process.argv.slice(2);
const wanted = parseSymbols(rest.join(','));
const file = process.env.KS_SYMBOLS || SYMBOLS_FILE;
const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
const current = parseSymbols(text).map((s) => KS.symbolOf(KS.coinOf(s)).toUpperCase());

if (cmd === 'list') { console.log(current.join('\n') || '(no markets yet)'); process.exit(0); }
if (!['add', 'remove'].includes(cmd) || !wanted.length) { console.error('Usage: node server/markets.js add|remove|list NAME [NAME ...]'); process.exit(1); }

const api = KS.createApi({ url: process.env.HL_API_URL || undefined });
let lines = text.split(/\r?\n/);

if (cmd === 'add') {
  const { ok, bad, unchecked, error } = await resolveSymbols(api, wanted);
  if (unchecked) { console.error('Could not reach Hyperliquid to check the names: ' + error); process.exit(1); }
  if (bad.length) { console.error(`Not a Hyperliquid perpetual: ${bad.join(', ')}. Nothing was changed.`); process.exit(1); }
  const added = ok.filter((s) => !current.includes(s.toUpperCase()));
  for (const s of ok) if (!added.includes(s)) console.log(`${s} is already in the list.`);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push(...added);
  if (added.length) console.log('Added: ' + added.join(', '));
} else {
  const drop = new Set(wanted.map((w) => KS.coinOf(w).toLowerCase()));
  const before = lines.length;
  lines = lines.filter((l) => { const t = l.replace(/#.*/, '').trim(); return !t || !drop.has(KS.coinOf(t).toLowerCase()); });
  console.log(before === lines.length ? 'Nothing matched, nothing removed.' : 'Removed: ' + wanted.join(', '));
}
writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'));
console.log('\nNow watching:\n' + parseSymbols(readFileSync(file, 'utf8')).join('\n'));
