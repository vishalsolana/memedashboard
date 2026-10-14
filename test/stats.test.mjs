import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBonds, addCreates, buildPublic, DAY, emptyState, LAG, nextWindow, prune, quantile } from '../scripts/lib/stats.mjs';
import { migrateMint } from '../scripts/lib/bitquery.mjs';
import { needsHigh } from '../scripts/lib/gecko.mjs';

const NOW = Date.UTC(2026, 9, 14, 12) / 1000; // 2026-10-14 12:00 UTC
const YESTERDAY = NOW - 12 * 3600 - DAY; // 2026-10-13 00:00

test('quantile interpolates', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.25), 5);
  assert.equal(quantile([], 0.5), null);
});

test('nextWindow backfills once, then continues from the cursor', () => {
  const first = nextWindow(null, NOW);
  assert.equal(first.since, NOW - 12 * 3600 - 30 * DAY);
  assert.equal(first.till, NOW - LAG);
  assert.equal(nextWindow(null, NOW, 2).since, NOW - 12 * 3600 - 2 * DAY);
  const cursor = new Date((NOW - 3 * 3600) * 1000).toISOString();
  assert.deepEqual(nextWindow(cursor, NOW), { since: NOW - 3 * 3600, till: NOW - LAG });
  const stale = new Date((NOW - 60 * DAY) * 1000).toISOString();
  assert.equal(nextWindow(stale, NOW).since, NOW - 12 * 3600 - 30 * DAY);
});

test('migrateMint prefers the vanity pump mint', () => {
  assert.equal(migrateMint(['G', 'W', 'abcpump', 'BC']), 'abcpump');
  assert.equal(migrateMint(['G', 'W', 'Mint', 'BC']), 'Mint');
});

test('merge, prune and daily stats', () => {
  const s = emptyState();
  addCreates(s, [{ day: '2026-10-13', created: 12000 }]);
  addCreates(s, [{ day: '2026-10-13', created: 8000 }]); // a later window adds up
  addBonds(s, [
    { mint: 'A', bonded_at: YESTERDAY + 700 },
    { mint: 'B', bonded_at: YESTERDAY + 1000 },
    { mint: 'C', bonded_at: YESTERDAY + 2000 },
    { mint: 'OLD', bonded_at: NOW - 40 * DAY },
  ]);
  s.tokens.A.created_at = YESTERDAY + 100;
  s.tokens.B.created_at = YESTERDAY - 3000;
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

  // Seeing a bond again keeps its earliest time and what was learned since.
  s.tokens.A.pool = 'PA';
  assert.deepEqual(addBonds(s, [{ mint: 'A', bonded_at: YESTERDAY + 900 }]), []);
  assert.equal(s.tokens.A.bonded_at, YESTERDAY + 700);
  assert.equal(s.tokens.A.pool, 'PA');
});

test('needsHigh waits between provisional reads and stops once final', () => {
  const t = { bonded_at: NOW - 3600, high_final: false, high_fetched_at: null };
  assert.equal(needsHigh(t, NOW), true);
  assert.equal(needsHigh({ ...t, high_fetched_at: NOW - 600 }, NOW), false);
  assert.equal(needsHigh({ ...t, bonded_at: NOW - 2 * DAY, high_fetched_at: NOW - 600 }, NOW), true);
  assert.equal(needsHigh({ ...t, high_final: true }, NOW), false);
});
