const fs = require('fs');
const path = require('path');

// The 1200×630 share card (WhatsApp, Facebook, LinkedIn, X previews) for a page: CareerZ green,
// the logo, a small label (JOB · LAHORE), the page title and one line under it. English uses Inter,
// Urdu uses Noto Nastaliq Urdu and is laid out right to left. The same layout is drawn at build
// time for the fixed pages (frontend scripts/og-card.mjs).

const FONT = (pkg, file) => { try { return require.resolve(`${pkg}/${file}`); } catch { return null; } };
const FONTS = [
  FONT('@expo-google-fonts/inter', '700Bold/Inter_700Bold.ttf'),
  FONT('@expo-google-fonts/inter', '500Medium/Inter_500Medium.ttf'),
  FONT('@expo-google-fonts/noto-nastaliq-urdu', '400Regular/NotoNastaliqUrdu_400Regular.ttf')
].filter(Boolean);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function wrap(text, max, lines) {
  const out = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + word).trim().length > max && line) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
    if (out.length === lines) break;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && out.join(' ').length < String(text).trim().length) out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…';
  return out;
}

let logo = null;
function logoData() {
  if (logo !== null) return logo;
  const dir = path.dirname(process.env.SEO_TEMPLATE_PATH || '/var/www/careerz-frontend/site/app.html');
  try { logo = `data:image/png;base64,${fs.readFileSync(path.join(dir, 'logo2.png')).toString('base64')}`; } catch { logo = ''; }
  return logo;
}

function svg({ title, sub = '', label = '', lang = 'en' }) {
  const ur = lang === 'ur';
  const family = ur ? 'NotoNastaliqUrdu' : 'Inter';
  const lines = wrap(title, ur ? 30 : 26, 3);
  const size = lines.length > 2 ? 58 : 66;
  const x = ur ? 1120 : 80, anchor = ur ? 'end' : 'start';
  const top = 300 - (lines.length - 1) * (size * 0.62);
  const lg = logoData();
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f3d2e"/><stop offset="1" stop-color="#1d6b52"/></linearGradient></defs>
<rect width="1200" height="630" fill="url(#g)"/>
<circle cx="1080" cy="80" r="220" fill="#ffffff" opacity="0.05"/><circle cx="140" cy="600" r="180" fill="#e3a23c" opacity="0.08"/>
<rect x="${ur ? 1112 : 80}" y="96" width="8" height="56" rx="4" fill="#e3a23c"/>
${label ? `<text x="${ur ? 1092 : 104}" y="136" text-anchor="${anchor}" font-family="${ur ? family : 'Inter'}" font-weight="500" font-size="${ur ? 34 : 28}" letter-spacing="${ur ? 0 : 3}" fill="#e3a23c">${esc(ur ? label : label.toUpperCase())}</text>` : ''}
${lines.map((l, i) => `<text x="${x}" y="${Math.round(top + i * size * 1.25)}" text-anchor="${anchor}" font-family="${family}" font-weight="700" font-size="${ur ? size - 8 : size}" fill="#ffffff">${esc(l)}</text>`).join('')}
${sub ? `<text x="${x}" y="${Math.round(top + lines.length * size * 1.25 + 20)}" text-anchor="${anchor}" font-family="${ur ? family : 'Inter'}" font-weight="500" font-size="${ur ? 32 : 30}" fill="#d7efe4">${esc(wrap(sub, ur ? 60 : 62, 1)[0] || '')}</text>` : ''}
<rect x="0" y="548" width="1200" height="82" fill="#000000" opacity="0.18"/>
${lg ? `<image x="${ur ? 1040 : 80}" y="560" width="58" height="58" xlink:href="${lg}"/>` : ''}
<text x="${ur ? 1024 : 152}" y="600" text-anchor="${anchor}" font-family="Inter" font-weight="700" font-size="30" fill="#ffffff">CareerZ.pk</text>
<text x="${ur ? 80 : 1120}" y="600" text-anchor="${ur ? 'start' : 'end'}" font-family="${ur ? family : 'Inter'}" font-weight="500" font-size="${ur ? 26 : 24}" fill="#d7efe4">${esc(ur ? 'نوکریاں · اسکالرشپس · داخلے · کورسز' : 'Jobs · Scholarships · Admissions · Courses')}</text>
</svg>`;
}

function png(card) {
  const { Resvg } = require('@resvg/resvg-js');
  return new Resvg(svg(card), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
}

module.exports = { svg, png, wrap };
