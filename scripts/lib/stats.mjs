// Pure functions: merge Dune rows into state, prune, and build the public payload.

export const DAY = 86400;
export const WINDOW_DAYS = 30;
export const HIGH_WINDOW = DAY; // peak measured over the first 24h after bonding
export const HIGH_SETTLE = 30 * 60; // wait for GeckoTerminal to finish indexing the window
export const PUMP_SUPPLY = 1_000_000_000; // every pump.fun token mints 1B supply
const TOP_PER_DAY = 10;

export function emptyState() {
  return { version: 1, last_dune_sync: null, days: {}, tokens: {} };
}

export function dayKey(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function startOfDay(ts) {
  return Math.floor(ts / DAY) * DAY;
}

// How many whole days (counting today) the Dune query must scan to cover
// everything since the last successful sync. Always rescans yesterday so
// late-indexed rows land, and caps at the window plus one.
export function daysToScan(lastSyncIso, now) {
  if (!lastSyncIso) return WINDOW_DAYS + 2;
  const last = Date.parse(lastSyncIso) / 1000;
  if (!Number.isFinite(last)) return WINDOW_DAYS + 2;
  const days = Math.floor((startOfDay(now) - startOfDay(last)) / DAY) + 2;
  return Math.min(Math.max(days, 2), WINDOW_DAYS + 2);
}

export function mergeDuneRows(state, rows) {
  let days = 0;
  let bonds = 0;
  for (const row of rows) {
    if (row.kind === 'day' && row.day) {
      state.days[row.day] = { created: Number(row.created) };
      days++;
    } else if (row.kind === 'bond' && row.mint && row.bonded_ts != null) {
      const t = state.tokens[row.mint] ?? newToken();
      t.bonded_at = Math.round(Number(row.bonded_ts));
      if (row.created_ts != null) t.created_at = Math.round(Number(row.created_ts));
      if (row.pool && !t.pool) t.pool = row.pool;
      state.tokens[row.mint] = t;
      bonds++;
    }
  }
  return { days, bonds };
}

function newToken() {
  return {
    created_at: null,
    bonded_at: null,
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

    days.push({
      day: key,
      partial: i === 0,
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
    last_dune_sync: state.last_dune_sync,
    window_days: WINDOW_DAYS,
    method: {
      bonded: 'pump.fun CompleteEvent (bonding curve filled), counted on the UTC day it happened',
      time_to_bond: 'bonded time minus create time, per token, grouped by bond day',
      high: 'peak USD price in the first 24h after bonding (GeckoTerminal 15m candles) x 1B supply',
    },
    days,
    top,
  };
}
