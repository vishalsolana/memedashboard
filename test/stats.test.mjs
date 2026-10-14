import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublic, DAY, daysToScan, emptyState, mergeDuneRows, prune, quantile } from '../scripts/lib/stats.mjs';
import { needsHigh } from '../scripts/lib/gecko.mjs';

const NOW = Date.UTC(2026, 9, 14, 12) / 1000; // 2026-10-14 12:00 UTC
const YESTERDAY = NOW - 12 * 3600 - DAY; // 2026-10-13 00:00

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.25), 5);
  assert.equal(quantile([], 0.5), null);
});

test('daysToScan covers the gap since last sync and rescans yesterday', () => {
  assert.equal(daysToScan(null, NOW), 32);
  assert.equal(daysToScan(new Date((NOW - 3600) * 1000).toISOString(), NOW), 2);
  assert.equal(daysToScan(new Date((NOW - 3 * DAY) * 1000).toISOString(), NOW), 5);
  assert.equal(daysToScan(new Date((NOW - 90 * DAY) * 1000).toISOString(), NOW), 32);
});

test('merge, prune and daily stats', () => {
  const s = emptyState();
  mergeDuneRows(s, [
    { kind: 'day', day: '2026-10-13', created: 20000 },
    { kind: 'bond', mint: 'A', created_ts: YESTERDAY + 100, bonded_ts: YESTERDAY + 700, pool: 'PA' },
    { kind: 'bond', mint: 'B', created_ts: YESTERDAY - 3000, bonded_ts: YESTERDAY + 1000, pool: null },
    { kind: 'bond', mint: 'C', created_ts: null, bonded_ts: YESTERDAY + 2000, pool: null },
    { kind: 'bond', mint: 'OLD', created_ts: null, bonded_ts: NOW - 40 * DAY, pool: null },
  ]);
  Object.assign(s.tokens.A, { high_price: 0.0001, high_final: true, high_status: 'ok', symbol: 'AAA' });
  Object.assign(s.tokens.B, { high_price: 0.0003, high_final: false, high_status: 'ok' });
  Object.assign(s.tokens.C, { high_final: true, high_status: 'no_pool' });

  prune(s, NOW);
  assert.equal(s.tokens.OLD, undefined);

  const out = buildPublic(s, NOW);
  assert.equal(out.days.length, 31);
  assert.equal(out.days.at(-1).partial, true);
  const y = out.days.find((d) => d.day === '2026-10-13');
  assert.equal(y.created, 20000);
  assert.equal(y.bonded, 3);
  assert.equal(y.bond_rate, 3 / 20000);
  assert.equal(y.ttb.n, 2);
  assert.equal(y.ttb.median, (600 + 4000) / 2);
  assert.equal(y.ttb_unknown, 1);
  assert.equal(y.high.n, 2);
  assert.equal(y.high.median, 200_000);
  assert.equal(y.high_pending, 1);
  assert.equal(y.high_missing, 1);
  assert.equal(y.high_final, false);
  assert.deepEqual(out.top['2026-10-13'].map((t) => t.mint), ['B', 'A']);

  // A later sync keeps the pool learned earlier.
  mergeDuneRows(s, [{ kind: 'bond', mint: 'A', created_ts: YESTERDAY + 100, bonded_ts: YESTERDAY + 700, pool: null }]);
  assert.equal(s.tokens.A.pool, 'PA');
});

test('needsHigh waits between provisional reads and stops once final', () => {
  const t = { bonded_at: NOW - 3600, high_final: false, high_fetched_at: null };
  assert.equal(needsHigh(t, NOW), true);
  assert.equal(needsHigh({ ...t, high_fetched_at: NOW - 600 }, NOW), false);
  assert.equal(needsHigh({ ...t, bonded_at: NOW - 2 * DAY, high_fetched_at: NOW - 600 }, NOW), true);
  assert.equal(needsHigh({ ...t, high_final: true }, NOW), false);
});
