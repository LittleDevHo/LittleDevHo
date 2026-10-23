#!/usr/bin/env node
// Redraws the profile hero card (dark + light) and the README stats line
// from the public GitHub contribution graph. Zero dependencies, Node 20+.
//
// Fails closed: if GitHub's markup changes and parsing looks wrong, the
// script exits non-zero and leaves the last good card in place.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const USER = 'LittleDevHo';
const TZ = 'Asia/Seoul';
const ROOT = new URL('../', import.meta.url);
const file = (p) => new URL(p, ROOT);

const HEADERS = {
  'User-Agent': `${USER}-profile-builder`,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'text/html',
};

// ---------- data ----------

async function get(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      lastErr = new Error(`${res.status} ${url}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw lastErr;
}

function parseCalendar(html) {
  const idToDate = new Map();
  for (const [tag] of html.matchAll(/<td\b[^>]*>/g)) {
    const d = tag.match(/data-date="(\d{4}-\d{2}-\d{2})"/);
    const id = tag.match(/\bid="([^"]+)"/);
    if (d && id) idToDate.set(id[1], d[1]);
  }
  const days = new Map();
  for (const m of html.matchAll(/<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const date = idToDate.get(m[1]);
    if (!date) continue;
    const n = m[2].trim().match(/^([\d,]+) contributions?/);
    days.set(date, n ? Number(n[1].replace(/,/g, '')) : 0);
  }
  const t = html.match(/([\d,]+)\s+contributions?\s+in\s+(?:the last year|\d{4})/);
  return { days, total: t ? Number(t[1].replace(/,/g, '')) : null };
}

const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
const shift = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const fmt = (n) => n.toLocaleString('en-US');
const fmtDate = (iso, opts) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${iso}T00:00:00Z`));

async function collect() {
  const today = todayIn(TZ);
  const year = Number(today.slice(0, 4));
  const cal = (from, to) => `https://github.com/users/${USER}/contributions?from=${from}&to=${to}`;
  const [cur, prev, rolling] = await Promise.all([
    get(cal(`${year}-01-01`, `${year}-12-31`)).then(parseCalendar),
    get(cal(`${year - 1}-01-01`, `${year - 1}-12-31`)).then(parseCalendar),
    get(`https://github.com/users/${USER}/contributions`).then(parseCalendar),
  ]);

  if (cur.total == null || prev.total == null || rolling.total == null || cur.days.size < 300) {
    throw new Error('Contribution markup changed; refusing to overwrite the card.');
  }

  const all = new Map([...prev.days, ...cur.days]);
  const dates = [...all.keys()].filter((d) => d <= today).sort();
  const since = shift(today, -364);
  const window = dates.filter((d) => d >= since);

  let best = { date: window[0], n: -1 };
  for (const d of window) if (all.get(d) > best.n) best = { date: d, n: all.get(d) };

  let run = 0, longest = 0;
  for (const d of dates) { run = all.get(d) > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (all.get(dates[i]) > 0) current++;
    else if (dates[i] === today) continue; // today isn't over yet
    else break;
  }

  // Weekly totals (Sunday-start, like GitHub) from the first week of last year.
  const jan1 = `${year - 1}-01-01`;
  const start = shift(jan1, -new Date(`${jan1}T00:00:00Z`).getUTCDay());
  const weeks = [];
  for (let w = start; w <= today; w = shift(w, 7)) {
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += all.get(shift(w, i)) ?? 0;
    weeks.push({ start: w, n: sum });
  }

  const activeDays = window.filter((d) => all.get(d) > 0).length;
  return {
    user: USER,
    updated: today,
    year,
    lastYear: rolling.total,
    thisYear: cur.total,
    prevYear: prev.total,
    multiple: prev.total > 0 ? cur.total / prev.total : null,
    activeDays,
    windowDays: window.length,
    perActiveDay: activeDays ? rolling.total / activeDays : 0,
    bestDay: best,
    longestStreak: longest,
    currentStreak: current,
    weeks,
  };
}

// ---------- render ----------

const THEMES = {
  dark: {
    bg: '#0B0C0B', line: '#232523', ink: '#F3F0E8', muted: '#8C8A83', faint: '#2C2E2B',
    old: '#3A3D39', accent: '#5BE49B',
  },
  light: {
    bg: '#FAF9F5', line: '#E4E1D8', ink: '#151513', muted: '#6E6C65', faint: '#E2DFD6',
    old: '#CFCBC0', accent: '#0F7A46',
  },
};

function fontFaces(f) {
  const face = (fam, data, style = 'normal') =>
    `@font-face{font-family:${fam};font-style:${style};src:url(data:font/woff2;base64,${data}) format('woff2')}`;
  return face('S', f.serif) + face('S', f.serifItalic, 'italic') + face('M', f.mono);
}

function render(s, theme, fonts) {
  const c = THEMES[theme];
  const W = 1000, H = 628, X0 = 56, X1 = 944;
  const out = [];
  const t = (x, y, cls, body, extra = '') => out.push(`<text x="${x}" y="${y}" class="${cls}" ${extra}>${body}</text>`);

  // Header
  t(X0, 64, 'm cap ink', 'HOJIN KANG', '');
  t(X0 + 112, 64, 'm cap mut', '/  FOUNDER &amp; CEO, GRINDA AI');
  const live = `LIVE · ${fmtDate(s.updated, { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase()}`;
  const advance = 13 * 0.6 + 2.4; // Geist Mono is 0.6em wide, plus letter-spacing
  out.push(`<circle cx="${(X1 - live.length * advance - 10).toFixed(1)}" cy="59.5" r="3.5" class="acc p"/>`);
  t(X1, 64, 'm cap mut', live, 'text-anchor="end"');
  out.push(`<line x1="${X0}" y1="88" x2="${X1}" y2="88" class="hair"/>`);

  // Headline
  t(X0 - 3, 178, 's h1 ink', `${fmt(s.lastYear)} contributions`);
  t(X0 - 3, 258, 's h1 mut', 'in the last 12 months.');
  t(X0, 312, 's it acc', 'Shipped by one founder-CEO and his agents.');

  // Weekly bars
  const top = 360, base = 470, n = s.weeks.length;
  const pitch = (X1 - X0) / n, bw = Math.max(2, pitch * 0.6);
  const max = Math.max(...s.weeks.map((w) => w.n), 1);
  let peak = 0;
  s.weeks.forEach((w, i) => { if (w.n > s.weeks[peak].n) peak = i; });
  s.weeks.forEach((w, i) => {
    const x = X0 + i * pitch + (pitch - bw) / 2;
    const thisYear = w.start.slice(0, 4) === String(s.year) || shift(w.start, 6).slice(0, 4) === String(s.year);
    if (w.n === 0) {
      out.push(`<rect x="${x.toFixed(1)}" y="${base - 1}" width="${bw.toFixed(1)}" height="1" class="zero"/>`);
      return;
    }
    const h = Math.max(2, ((base - top) * w.n) / max);
    out.push(
      `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1" class="b ${thisYear ? 'acc' : 'old'}" style="animation-delay:${i * 7}ms"/>`
    );
  });
  // Year markers
  for (const y of [s.year - 1, s.year]) {
    const i = s.weeks.findIndex((w) => shift(w.start, 6) >= `${y}-01-01`);
    if (i < 0) continue;
    const x = X0 + i * pitch;
    if (y === s.year) out.push(`<line x1="${x.toFixed(1)}" y1="${top - 6}" x2="${x.toFixed(1)}" y2="${base}" class="hair dash"/>`);
    t(x.toFixed(1), base + 24, 'm sm mut', String(y));
  }
  // Peak label
  const px = X0 + peak * pitch + pitch / 2;
  const ph = ((base - top) * s.weeks[peak].n) / max;
  const anchor = px > X1 - 120 ? 'end' : 'middle';
  t(px.toFixed(1), (base - ph - 12).toFixed(1), 'm sm mut', `PEAK WEEK · ${fmt(s.weeks[peak].n)}`, `text-anchor="${anchor}"`);

  // Stats row
  out.push(`<line x1="${X0}" y1="514" x2="${X1}" y2="514" class="hair"/>`);
  const col = (X1 - X0) / 4;
  const mult = s.multiple == null ? '—' : s.multiple >= 100 ? `${Math.round(s.multiple)}×` : `${s.multiple.toFixed(1)}×`;
  const stats = [
    [`IN ${s.year} SO FAR`, `${fmt(s.thisYear)}`, ''],
    [`VS. ALL OF ${s.year - 1}`, mult, ''],
    ['ACTIVE DAYS', `${s.activeDays}`, ` / ${s.windowDays}`],
    ['BEST SINGLE DAY', `${fmt(s.bestDay.n)}`, ` · ${fmtDate(s.bestDay.date, { month: 'short', day: 'numeric' })}`],
  ];
  stats.forEach(([label, value, tail], i) => {
    const x = X0 + i * col;
    t(x, 548, 'm sm mut', label);
    t(x, 592, 's v ink', `${value}${tail ? `<tspan class="m tail mut">${tail}</tspan>` : ''}`);
  });

  const css = `
${fontFaces(fonts)}
.s{font-family:S,'Iowan Old Style','Palatino Linotype',Georgia,serif}
.m{font-family:M,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.cap{font-size:13px;letter-spacing:2.4px}
.sm{font-size:11.5px;letter-spacing:1.8px}
.h1{font-size:82px;letter-spacing:-1.2px}
.it{font-size:36px;font-style:italic}
.v{font-size:40px;letter-spacing:-.4px}
.tail{font-size:14px;letter-spacing:.6px}
.ink{fill:${c.ink}}.mut{fill:${c.muted}}.acc{fill:${c.accent}}.old{fill:${c.old}}.zero{fill:${c.faint}}
.hair{stroke:${c.line};stroke-width:1}.dash{stroke-dasharray:2 4}
.b{transform-box:fill-box;transform-origin:50% 100%;animation:g .9s cubic-bezier(.2,.7,.2,1) both}
@keyframes g{from{transform:scaleY(0)}to{transform:scaleY(1)}}
.p{animation:p 2.4s ease-in-out infinite}
@keyframes p{0%,100%{opacity:1}50%{opacity:.2}}
@media (prefers-reduced-motion:reduce){.b,.p{animation:none}}`;

  const title = `${fmt(s.lastYear)} contributions in the last 12 months. Shipped by one founder-CEO and his agents.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
<title>${title}</title>
<style>${css}</style>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="18" fill="${c.bg}" stroke="${c.line}"/>
${out.join('\n')}
</svg>
`;
}

// ---------- README ----------

function replaceBlock(src, name, body) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(<!-- ${name}:end -->)`);
  if (!re.test(src)) throw new Error(`README is missing the ${name} markers`);
  return src.replace(re, `$1\n${body}\n$2`);
}

async function main() {
  const fonts = JSON.parse(await readFile(file('scripts/fonts.json'), 'utf8'));
  const s = await collect();

  // Sanity check against the last good run: a sudden collapse means parsing broke
  // (or private contributions were switched off), not that the work stopped.
  try {
    const prev = JSON.parse(await readFile(file('data/stats.json'), 'utf8'));
    if (prev.lastYear && s.lastYear < prev.lastYear * 0.5) {
      throw new Error(`lastYear dropped from ${prev.lastYear} to ${s.lastYear}; refusing to publish.`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  await mkdir(file('assets'), { recursive: true });
  await mkdir(file('data'), { recursive: true });
  await writeFile(file('assets/hero-dark.svg'), render(s, 'dark', fonts));
  await writeFile(file('assets/hero-light.svg'), render(s, 'light', fonts));
  const { weeks, ...summary } = s;
  await writeFile(file('data/stats.json'), JSON.stringify({ ...summary, weeks }, null, 2) + '\n');

  const alt = `${fmt(s.lastYear)} contributions in the last 12 months, shipped by one founder-CEO and his agents. ${fmt(s.thisYear)} so far in ${s.year}; ${s.activeDays} active days out of ${s.windowDays}.`;
  const hero = `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./assets/hero-light.svg">
  <img alt="${alt}" src="./assets/hero-light.svg" width="100%">
</picture>`;
  const line = `<sub><samp>${fmt(s.lastYear)} contributions in the last 12 months · ${s.activeDays} active days · ~${Math.round(s.perActiveDay)} per active day · updated ${fmtDate(s.updated, { month: 'short', day: 'numeric', year: 'numeric' })}</samp></sub>`;

  let readme = await readFile(file('README.md'), 'utf8');
  readme = replaceBlock(readme, 'hero', hero);
  readme = replaceBlock(readme, 'stats', line);
  await writeFile(file('README.md'), readme);

  console.log(JSON.stringify(summary));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
