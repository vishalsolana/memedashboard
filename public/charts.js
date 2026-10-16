// Small dependency-free SVG charts: daily columns, and a line with an optional
// p25–p75 band. Each redraws on resize and has a hover crosshair + tooltip.

const NS = 'http://www.w3.org/2000/svg';
const M = { top: 8, right: 8, bottom: 22, left: 48 };
const tooltip = () => document.getElementById('tooltip');

export function chart(plot, opts) {
  const draw = () => render(plot, opts);
  plot._ro?.disconnect();
  plot._ro = new ResizeObserver(draw);
  plot._ro.observe(plot);
  draw();
}

function render(plot, { kind, points, color, yFormat, tip, ticks: makeTicks = niceTicks }) {
  plot.replaceChildren();
  const values = points.flatMap((p) => [p.y, p.hi]).filter((v) => v != null);
  if (!values.length) {
    plot.innerHTML = '<div class="empty">No data yet</div>';
    return;
  }

  const W = plot.clientWidth;
  const H = plot.clientHeight;
  if (W < M.left + M.right + 40) return; // not laid out yet; the observer redraws
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const n = points.length;
  const step = iw / n;
  const cx = (i) => M.left + step * (i + 0.5);
  const ticks = makeTicks(Math.max(...values));
  const yMax = ticks[ticks.length - 1];
  const sy = (v) => M.top + ih - (v / yMax) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  for (const t of ticks) {
    svg.append(el('line', { x1: M.left, x2: W - M.right, y1: sy(t), y2: sy(t), stroke: t === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
    const label = el('text', { x: M.left - 8, y: sy(t) + 4, 'text-anchor': 'end', class: 'tick' });
    label.textContent = yFormat(t);
    svg.append(label);
  }

  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  points.forEach((p, i) => {
    if ((n - 1 - i) % every) return;
    const t = el('text', { x: cx(i), y: H - 6, 'text-anchor': 'middle', class: 'tick' });
    t.textContent = shortDay(p.day);
    svg.append(t);
  });

  const hover = el('rect', { y: M.top, height: ih, width: step, fill: 'var(--accent-wash)', visibility: 'hidden' });
  svg.append(hover);

  if (kind === 'column') {
    const bw = Math.min(24, Math.max(2, step - 2));
    points.forEach((p, i) => {
      if (p.y == null || p.y <= 0) return;
      svg.append(el('path', { d: roundTop(cx(i) - bw / 2, sy(p.y), bw, sy(0) - sy(p.y), Math.min(4, bw / 2)), fill: color, opacity: p.faded ? 0.4 : 1 }));
    });
  } else {
    const band = segments(points, (p) => p.lo != null && p.hi != null);
    for (const seg of band) {
      const top = seg.map((i) => `${cx(i)},${sy(points[i].hi)}`);
      const bottom = seg.map((i) => `${cx(i)},${sy(points[i].lo)}`).reverse();
      svg.append(el('polygon', { points: [...top, ...bottom].join(' '), fill: color, opacity: 0.14 }));
    }
    for (const seg of segments(points, (p) => p.y != null)) {
      const d = seg.map((i, k) => `${k ? 'L' : 'M'}${cx(i)},${sy(points[i].y)}`).join('');
      svg.append(el('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    points.forEach((p, i) => {
      if (p.y == null) return;
      const last = i === lastIndex(points);
      if (!p.hollow && !last) return;
      svg.append(el('circle', { cx: cx(i), cy: sy(p.y), r: 4, fill: p.hollow ? 'var(--surface)' : color, stroke: p.hollow ? color : 'var(--surface)', 'stroke-width': 2 }));
    });
  }

  const marker = el('circle', { r: 5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  svg.append(marker);

  const hit = el('rect', { x: M.left, y: M.top, width: iw, height: ih, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - box.left - M.left) / step)));
    hover.setAttribute('x', M.left + step * i);
    hover.setAttribute('visibility', 'visible');
    const p = points[i];
    if (kind === 'line' && p.y != null) {
      marker.setAttribute('cx', cx(i));
      marker.setAttribute('cy', sy(p.y));
      marker.setAttribute('visibility', 'visible');
    } else {
      marker.setAttribute('visibility', 'hidden');
    }
    showTip(tip(p), e.clientX, e.clientY);
  });
  hit.addEventListener('pointerleave', () => {
    hover.setAttribute('visibility', 'hidden');
    marker.setAttribute('visibility', 'hidden');
    tooltip().hidden = true;
  });

  plot.append(svg);
}

function showTip(html, x, y) {
  const t = tooltip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y - r.height - 12;
  if (top < 8) top = y + 16;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}

function segments(points, ok) {
  const out = [];
  let cur = [];
  points.forEach((p, i) => {
    if (ok(p)) cur.push(i);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

function lastIndex(points) {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].y != null) return i;
  return -1;
}

function roundTop(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function niceTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(+v.toPrecision(12));
  return ticks;
}

// Ticks on round durations, for values in minutes.
export function durationTicks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 7200, 14400];
  const step = steps.find((s) => s >= max / count) ?? Math.ceil(max / count / 1440) * 1440;
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(v);
  return ticks;
}

function shortDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
