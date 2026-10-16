import { chart, durationTicks } from './charts.js';

const $ = (id) => document.getElementById(id);
let data;
let range = 30;

const num = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fmtNum = (v) => (v == null ? '–' : v >= 10000 ? compact.format(v) : num.format(Math.round(v)));
const fmtUsd = (v) => (v == null ? '–' : '$' + compact.format(v));
const fmtPct = (v) => (v == null ? '–' : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);

function fmtDur(sec) {
  if (sec == null) return '–';
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = sec / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? +h.toFixed(1) : Math.round(h)}h`;
  return `${+(h / 24).toFixed(1)}d`;
}

function fmtDay(day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

function ago(iso) {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const row = (k, v) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;

async function load() {
  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('updated').textContent = 'Could not load data.';
    return;
  }
  const any = (data.days ?? []).some((d) => d.created != null);
  $('updated').textContent = !data.last_sync
    ? 'Waiting for the first data refresh'
    : data.counting_since
      ? `Live feed · updated ${ago(data.last_sync)} · counting since ${fmtTime(data.counting_since)} · UTC days`
      : `Updated ${ago(data.last_sync)} · refreshed every 3h · UTC days`;
  if (!any) {
    $('notice').hidden = false;
    $('notice').textContent = 'No data yet. Start the listener (npm run listen) or run the data workflow (see README).';
  }
  renderTiles();
  renderCharts();
  renderTop();
  renderDailyTable();
}

// The selected range, ending with today (drawn faded as a partial day).
function rangeDays() {
  return data.days.slice(-range);
}

const isPartial = (d) => d.partial || (d.coverage != null && d.coverage < 0.99);

function dayTitle(d) {
  const notes = [];
  if (d.partial) notes.push('so far');
  if (d.coverage === 0) notes.push('not tracked');
  else if (d.coverage != null && d.coverage < 0.99) notes.push(`${Math.round(d.coverage * 100)}% of day covered`);
  return `<strong>${fmtDay(d.day)}${notes.length ? ` · ${notes.join(' · ')}` : ''}</strong>`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC';
}

function renderTiles() {
  const full = data.days.filter((d) => !d.partial && d.created != null);
  const today = data.days.find((d) => d.partial);
  // Until a full day exists (first day of a live listener), show today so far.
  const y = full[full.length - 1] ?? (today?.created != null ? today : null);
  if (!y) {
    $('tiles').replaceChildren();
    return;
  }
  const label = y.partial
    ? 'Today so far'
    : `${fmtDay(y.day)}${isPartial(y) ? ` · ${Math.round(y.coverage * 100)}% covered` : ''}`;
  const tiles = [
    ['Tokens created', fmtNum(y.created), label],
    ['Tokens bonded', fmtNum(y.bonded), label],
    ['Bond rate', fmtPct(y.bond_rate), label],
    ['Median time to bond', fmtDur(y.ttb?.median), `avg ${fmtDur(y.ttb?.mean)}`],
    [
      'Median bonded-token high',
      fmtUsd(y.high?.median),
      y.high_final ? `avg ${fmtUsd(y.high?.mean)}` : `settling · ${y.high_pending} pending`,
    ],
  ];
  $('tiles').innerHTML = tiles
    .map(([l, v, n]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${n}</div></div>`)
    .join('');
  $('today').textContent = today?.created != null && y !== today
    ? `Today so far (UTC): ${fmtNum(today.created)} created · ${fmtNum(today.bonded)} bonded`
    : '';
}

function renderCharts() {
  const days = rangeDays();
  const s1 = 'var(--series-1)';
  const s2 = 'var(--series-2)';

  chart(document.querySelector('#chart-created .plot'), {
    kind: 'column',
    color: s1,
    points: days.map((d) => ({ day: d.day, y: d.created, faded: isPartial(d), d })),
    yFormat: fmtNum,
    tip: (p) => `${dayTitle(p.d)}${row('Created', fmtNum(p.y))}`,
  });

  chart(document.querySelector('#chart-bonded .plot'), {
    kind: 'column',
    color: s2,
    points: days.map((d) => ({ day: d.day, y: d.bonded, faded: isPartial(d), d })),
    yFormat: fmtNum,
    tip: (p) => `${dayTitle(p.d)}${row('Bonded', fmtNum(p.y))}`,
  });

  chart(document.querySelector('#chart-rate .plot'), {
    kind: 'line',
    color: s2,
    points: days.map((d) => ({ day: d.day, y: d.bond_rate, hollow: isPartial(d), d })),
    yFormat: (v) => `${+(v * 100).toFixed(2)}%`,
    tip: (p) =>
      `${dayTitle(p.d)}${row('Bond rate', fmtPct(p.y))}` +
      row('Bonded', fmtNum(p.d.bonded)) + row('Created', fmtNum(p.d.created)),
  });

  // Minutes on the axis keeps the ticks on round durations.
  const min = (s) => (s == null ? null : s / 60);
  chart(document.querySelector('#chart-ttb .plot'), {
    kind: 'line',
    color: s2,
    points: days.map((d) => ({ day: d.day, y: min(d.ttb?.median), lo: min(d.ttb?.p25), hi: min(d.ttb?.p75), hollow: isPartial(d), d })),
    ticks: durationTicks,
    yFormat: (m) => fmtDur(m * 60),
    tip: (p) =>
      dayTitle(p.d) +
      (p.d.ttb
        ? row('Median', fmtDur(p.d.ttb.median)) + row('p25 – p75', `${fmtDur(p.d.ttb.p25)} – ${fmtDur(p.d.ttb.p75)}`) +
          row('Average', fmtDur(p.d.ttb.mean)) + row('Fastest', fmtDur(p.d.ttb.min)) + row('Tokens', fmtNum(p.d.ttb.n))
        : row('No bonded tokens', '')),
  });

  chart(document.querySelector('#chart-high .plot'), {
    kind: 'line',
    color: s2,
    points: days.map((d) => ({
      day: d.day,
      y: d.high?.median ?? null,
      lo: d.high?.p25 ?? null,
      hi: d.high?.p75 ?? null,
      hollow: (d.high != null && !d.high_final) || isPartial(d),
      d,
    })),
    yFormat: fmtUsd,
    tip: (p) =>
      dayTitle(p.d) + (p.d.high && !p.d.high_final ? row('Highs', 'still settling') : '') +
      (p.d.high
        ? row('Median', fmtUsd(p.d.high.median)) + row('p25 – p75', `${fmtUsd(p.d.high.p25)} – ${fmtUsd(p.d.high.p75)}`) +
          row('Average', fmtUsd(p.d.high.mean)) + row('Highest', fmtUsd(p.d.high.max)) + row('Tokens', fmtNum(p.d.high.n)) +
          (p.d.high_pending ? row('Pending', fmtNum(p.d.high_pending)) : '') +
          (p.d.high_missing ? row('No price data', fmtNum(p.d.high_missing)) : '')
        : row('No highs yet', '')),
  });
}

function renderTop() {
  const select = $('top-day');
  const days = Object.keys(data.top ?? {}).sort().reverse();
  if (!days.length) {
    $('top-table').innerHTML = '<tbody><tr><td class="muted">No bonded tokens with price data yet.</td></tr></tbody>';
    return;
  }
  const latestFull = days.find((d) => !data.days.find((x) => x.day === d)?.partial) ?? days[0];
  select.innerHTML = days.map((d) => `<option value="${d}"${d === latestFull ? ' selected' : ''}>${fmtDay(d)}</option>`).join('');
  const draw = () => {
    const list = data.top[select.value] ?? [];
    $('top-table').innerHTML =
      '<thead><tr><th>Token</th><th>24h high (mcap)</th><th>Time to bond</th><th>Bonded (UTC)</th><th>Links</th></tr></thead><tbody>' +
      list
        .map((t) => {
          const name = t.symbol ? escapeHtml(t.symbol) : `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`;
          const time = new Date(t.bonded_at * 1000).toISOString().slice(11, 16);
          return `<tr><td>${name}${t.final ? '' : ' <span class="muted">· settling</span>'}</td>` +
            `<td>${fmtUsd(t.high_mcap)}</td><td>${fmtDur(t.ttb)}</td><td>${time}</td>` +
            `<td><a href="https://pump.fun/coin/${t.mint}" target="_blank" rel="noopener">pump.fun</a> · ` +
            `<a href="https://dexscreener.com/solana/${t.mint}" target="_blank" rel="noopener">chart</a></td></tr>`;
        })
        .join('') +
      '</tbody>';
  };
  select.onchange = draw;
  draw();
}

function renderDailyTable() {
  const rows = [...data.days].reverse();
  $('daily-table').innerHTML =
    '<thead><tr><th>Day (UTC)</th><th>Coverage</th><th>Created</th><th>Bonded</th><th>Bond rate</th><th>Median TTB</th><th>Avg TTB</th><th>Median high</th><th>Avg high</th></tr></thead><tbody>' +
    rows
      .map(
        (d) =>
          `<tr><td>${d.day}${d.partial ? ' <span class="muted">(so far)</span>' : ''}</td>` +
          `<td>${d.coverage == null ? '–' : `${Math.round(d.coverage * 100)}%`}</td><td>${fmtNum(d.created)}</td>` +
          `<td>${fmtNum(d.bonded)}</td><td>${fmtPct(d.bond_rate)}</td><td>${fmtDur(d.ttb?.median)}</td>` +
          `<td>${fmtDur(d.ttb?.mean)}</td><td>${fmtUsd(d.high?.median)}${d.high && !d.high_final ? ' <span class="muted">*</span>' : ''}</td>` +
          `<td>${fmtUsd(d.high?.mean)}</td></tr>`,
      )
      .join('') +
    '</tbody>';
}

document.querySelectorAll('[data-range]').forEach((btn) =>
  btn.addEventListener('click', () => {
    range = Number(btn.dataset.range);
    document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    if (data) renderCharts();
  }),
);

load();
