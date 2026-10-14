// GeckoTerminal public API (no key, ~30 calls/min): find each bonded token's
// pool and read its peak price over the first 24h after bonding.
// Docs: https://www.geckoterminal.com/dex-api

import { HIGH_SETTLE, HIGH_WINDOW } from './stats.mjs';

const BASE = 'https://api.geckoterminal.com/api/v2';
const MIN_INTERVAL_MS = 2200;
const CANDLE = 15 * 60;
const MAX_POOL_LOOKUPS = 3;
const REFRESH_PROVISIONAL = 150 * 60; // re-read an open window at most every 2.5h

export class Gecko {
  constructor({ budget, log = console.log }) {
    this.budget = budget;
    this.calls = 0;
    this.last = 0;
    this.log = log;
  }

  get exhausted() {
    return this.calls >= this.budget;
  }

  async get(path) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      const res = await fetch(BASE + path, { headers: { Accept: 'application/json;version=20230302' } });
      if (res.status === 404) return null;
      if (res.status === 429 && attempt < 3) {
        this.log(`gecko: rate limited, backing off`);
        await sleep(30000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`gecko: ${res.status} ${path}`);
      return res.json();
    }
  }

  async findPool(mint) {
    const body = await this.get(`/networks/solana/tokens/${mint}/pools?page=1`);
    const pools = body?.data ?? [];
    const pump = pools.find((p) => /pump/i.test(p.relationships?.dex?.data?.id ?? ''));
    return (pump ?? pools[0])?.attributes?.address ?? null;
  }

  // Returns { high, highAt, name, symbol } or null when the pool is unknown.
  async peak(pool, mint, bondedAt, now) {
    const windowEnd = bondedAt + HIGH_WINDOW;
    const before = Math.min(now, windowEnd);
    const first = Math.floor(bondedAt / CANDLE) * CANDLE;
    const limit = Math.min(100, Math.ceil((before - first) / CANDLE) + 1);
    const body = await this.get(
      `/networks/solana/pools/${pool}/ohlcv/minute?aggregate=15&before_timestamp=${before}` +
        `&limit=${limit}&currency=usd&token=${mint}`,
    );
    if (!body) return null;
    const meta = [body.meta?.base, body.meta?.quote].find((m) => m?.address === mint) ?? body.meta?.base;
    let high = null;
    let highAt = null;
    for (const [ts, , h] of body.data?.attributes?.ohlcv_list ?? []) {
      if (ts < first || ts >= windowEnd) continue;
      if (high == null || h > high) {
        high = h;
        highAt = ts;
      }
    }
    return { high, highAt, name: meta?.name ?? null, symbol: meta?.symbol ?? null };
  }
}

export function needsHigh(t, now) {
  if (t.high_final) return false;
  const settled = now >= t.bonded_at + HIGH_WINDOW + HIGH_SETTLE;
  if (!settled && t.high_fetched_at && now - t.high_fetched_at < REFRESH_PROVISIONAL) return false;
  return true;
}

// Fills in highs for as many tokens as the call budget allows, newest bonds first.
export async function updateHighs(state, gecko, now) {
  const queue = Object.entries(state.tokens)
    .filter(([, t]) => needsHigh(t, now))
    .sort(([, a], [, b]) => b.bonded_at - a.bonded_at);
  let done = 0;

  for (const [mint, t] of queue) {
    if (gecko.exhausted) break;
    const settled = now >= t.bonded_at + HIGH_WINDOW + HIGH_SETTLE;
    if (settled && t.pool_lookups >= MAX_POOL_LOOKUPS * 2) {
      t.high_status = t.high_price != null ? 'ok' : 'no_pool';
      t.high_final = true;
      continue;
    }

    if (!t.pool) {
      t.pool = await gecko.findPool(mint);
      if (!t.pool) {
        t.pool_lookups++;
        t.high_fetched_at = now;
        if (settled && t.pool_lookups >= MAX_POOL_LOOKUPS) {
          t.high_status = 'no_pool';
          t.high_final = true;
        }
        continue;
      }
      if (gecko.exhausted) break;
    }

    const peak = await gecko.peak(t.pool, mint, t.bonded_at, now);
    t.high_fetched_at = now;
    if (!peak) {
      // GeckoTerminal does not know this pool; look it up by token next time.
      t.pool = null;
      t.pool_lookups++;
      continue;
    }
    t.name ??= peak.name;
    t.symbol ??= peak.symbol;
    if (peak.high != null) {
      t.high_price = peak.high;
      t.high_at = peak.highAt;
      t.high_status = 'ok';
    } else if (settled) {
      t.high_status = 'no_trades';
    }
    t.high_final = settled;
    done++;
  }
  return { queued: queue.length, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
