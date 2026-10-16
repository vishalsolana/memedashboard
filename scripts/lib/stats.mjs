// Pure functions: merge fetched data into state, prune, and build the public payload.

export const DAY = 86400;
export const WINDOW_DAYS = 30;
export const HIGH_WINDOW = DAY; // peak measured over the first 24h after bonding
export const HIGH_SETTLE = 30 * 60; // wait for GeckoTerminal to finish indexing the window
export const PUMP_SUPPLY = 1_000_000_000; // every pump.fun token mints 1B supply
const TOP_PER_DAY = 10;

export function emptyState() {
  return { version: 2, cursor: null, days: {}, tokens: {} };
}

export function dayKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function startOfDay(ts) {
  return Math.floor(ts / DAY) * DAY;
}

export const LAG = 10 * 60; // leave the newest 10 minutes for the indexer to catch up

// The next [since, till) window to fetch. Windows never overlap, so per-day
// create counts can be added up across runs. First run backfills `backfillDays`.
export function nextWindow(cursorIso, now, backfillDays = WINDOW_DAYS) {
  const till = now - LAG;
  const floor = startOfDay(now) - WINDOW_DAYS * DAY;
  const cursor = cursorIso ? Date.parse(cursorIso) / 1000 : NaN;
  const since = Number.isFinite(cursor) && cursor >= floor ? cursor : Math.max(floor, startOfDay(now) - backfillDays * DAY);
  return { since, till: Math.max(since, till) };
}

export function addCreates(state, rows) {
  for (const { day, created } of rows) {
    state.days[day] = { created: (state.days[day]?.created ?? 0) + created };
  }
}

export function addBonds(state, bonds) {
  const added = [];
  for (const { mint, bonded_at, signature = null } of bonds) {
    const t = state.tokens[mint] ?? newToken();
    if (t.bonded_at == null || bonded_at < t.bonded_at) {
      t.bonded_at = bonded_at;
      t.bond_sig = signature;
    }
    if (!state.tokens[mint]) added.push(mint);
    state.tokens[mint] = t;
  }
  return added;
}

// Coverage: [start, end] intervals (unix seconds) when a live listener was
// connected. Days it only partly covers are shown as partial counts.
export function addCoverage(state, start, end) {
  if (!(end > start)) return;
  const list = [...(state.coverage ?? []), [start, end]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of list) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 5) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  state.coverage = merged;
}

export function coveredSeconds(state, from, to) {
  let total = 0;
  for (const [a, b] of state.coverage ?? []) total += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return total;
}

function newToken() {
  return {
    created_at: null,
    create_checked: false, // true once the create time was found or given up on
    bonded_at: null,
    bond_sig: null,
    pool: null,
    pool_lookups: 0,
    name: null,
    symbol: null,
    high_price: null,
    high_at: null,
    high_status: 'pending', // pending | ok | no_pool | no_trades
    high_final: false,
    high_fetched_at: null,
  };
}

// Keep the window plus one spare day so the oldest charted day is complete.
export function prune(state, now) {
  const cutoff = startOfDay(now) - (WINDOW_DAYS + 1) * DAY;
  const cutoffKey = dayKey(cutoff);
  for (const day of Object.keys(state.days)) {
    if (day < cutoffKey) delete state.days[day];
  }
  if (state.coverage) state.coverage = state.coverage.filter(([, b]) => b >= cutoff);
  for (const [mint, t] of Object.entries(state.tokens)) {
    if (t.bonded_at < cutoff) delete state.tokens[mint];
  }
}

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function summarize(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    median: quantile(s, 0.5),
    p25: quantile(s, 0.25),
    p75: quantile(s, 0.75),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    min: s[0],
    max: s[s.length - 1],
  };
}

export function mcapOf(token) {
  return token.high_price == null ? null : token.high_price * PUMP_SUPPLY;
}

export function buildPublic(state, now) {
  const today = startOfDay(now);
  const byDay = new Map();
  for (const [mint, t] of Object.entries(state.tokens)) {
    const key = dayKey(t.bonded_at);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ mint, ...t });
  }

  const days = [];
  for (let i = WINDOW_DAYS; i >= 0; i--) {
    const start = today - i * DAY;
    const key = dayKey(start);
    const created = state.days[key]?.created ?? null;
    const bonded = byDay.get(key) ?? [];

    const ttb = bonded
      .filter((t) => t.created_at != null && t.bonded_at >= t.created_at)
      .map((t) => t.bonded_at - t.created_at);

    const highs = bonded.filter((t) => t.high_price != null).map(mcapOf);
    const pending = bonded.filter((t) => !t.high_final).length;
    const missing = bonded.filter((t) => t.high_final && t.high_price == null).length;

    // Without coverage intervals (batch sources) every day counts as fully covered.
    const coverage = state.coverage
      ? coveredSeconds(state, start, Math.min(start + DAY, now)) / Math.max(1, Math.min(start + DAY, now) - start)
      : null;

    days.push({
      day: key,
      partial: i === 0,
      coverage: coverage == null ? null : Math.round(coverage * 1000) / 1000,
      created,
      bonded: created == null && bonded.length === 0 ? null : bonded.length,
      bond_rate: created ? bonded.length / created : null,
      ttb: summarize(ttb),
      ttb_unknown: bonded.length - ttb.length,
      high: summarize(highs),
      high_pending: pending,
      high_missing: missing,
      high_final: bonded.length > 0 && pending === 0,
    });
  }

  const top = {};
  for (const d of days) {
    const list = (byDay.get(d.day) ?? [])
      .filter((t) => t.high_price != null)
      .sort((a, b) => b.high_price - a.high_price)
      .slice(0, TOP_PER_DAY)
      .map((t) => ({
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        pool: t.pool,
        high_mcap: mcapOf(t),
        high_at: t.high_at,
        bonded_at: t.bonded_at,
        ttb: t.created_at != null ? t.bonded_at - t.created_at : null,
        final: t.high_final,
      }));
    if (list.length) top[d.day] = list;
  }

  return {
    generated_at: new Date(now * 1000).toISOString(),
    last_sync: state.cursor,
    counting_since: state.coverage?.[0]?.[0] ? new Date(state.coverage[0][0] * 1000).toISOString() : null,
    window_days: WINDOW_DAYS,
    method: {
      bonded: 'pump.fun migrate instruction (curve filled, moved to PumpSwap), counted on the UTC day it happened',
      time_to_bond: 'bonded time minus create time, per token, grouped by bond day',
      high: 'peak USD price in the first 24h after bonding (GeckoTerminal 15m candles) x 1B supply',
    },
    days,
    top,
  };
}
