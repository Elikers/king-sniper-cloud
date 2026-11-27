// Packs the website into one HTML file that opens by double-click (charts only, no Discord alerts).
import { readFileSync, writeFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const inline = (code) => code.replace(/<\/script/gi, '<\\/script');
let html = read('./public/index.html').replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('./public/style.css')}</style>`);
const pine = JSON.stringify(read('./indicator/king_sniper_smart_filter.pine'));
let first = true;
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const lead = first ? `<script>globalThis.KS_PINE=${inline(pine)};</script>\n` : '';
  first = false;
  return `${lead}<script>\n${inline(read('./public/' + src))}</script>`;
});
writeFileSync(new URL('./king-sniper-chart.html', import.meta.url), html);
console.log('Wrote king-sniper-chart.html');
