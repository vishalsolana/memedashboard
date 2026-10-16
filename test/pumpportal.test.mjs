import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPumpFunMint, parseEvent } from '../scripts/lib/pumpportal.mjs';
import { addCoverage, buildPublic, coveredSeconds, DAY, emptyState } from '../scripts/lib/stats.mjs';

test('parseEvent reads creates, migrations and confirmations', () => {
  const create = parseEvent(JSON.stringify({ txType: 'create', mint: 'Apump', signature: 'S', pool: 'pump', symbol: 'A' }), 100);
  assert.deepEqual(create, { type: 'create', mint: 'Apump', signature: 'S', at: 100, name: null, symbol: 'A', pool: 'pump' });
  assert.equal(parseEvent(JSON.stringify({ txType: 'create', mint: 'B', pool: 'bonk' }), 100), null);
  assert.equal(parseEvent(JSON.stringify({ txType: 'migrate', mint: 'Apump', signature: 'M', timestamp: 1760000000123 }), 1).at, 1760000000);
  assert.equal(parseEvent(JSON.stringify({ mint: 'Apump', signature: 'M' }), 5).type, 'bond');
  assert.equal(parseEvent(JSON.stringify({ txType: 'buy', mint: 'Apump' }), 5), null);
  assert.deepEqual(parseEvent(JSON.stringify({ message: 'Successfully subscribed' }), 5), { type: 'info', text: 'Successfully subscribed' });
  assert.equal(parseEvent('not json', 5), null);
});

test('coverage merges intervals and marks partly covered days', () => {
  const s = emptyState();
  const day = Date.UTC(2026, 9, 15) / 1000;
  addCoverage(s, day + 3600, day + 7200);
  addCoverage(s, day + 7000, day + 10800); // overlaps, merges
  addCoverage(s, day + DAY / 2, day + DAY);
  assert.equal(s.coverage.length, 2);
  assert.equal(coveredSeconds(s, day, day + DAY), 7200 + DAY / 2);
  s.days['2026-10-15'] = { created: 100 };
  const out = buildPublic(s, day + DAY + 3600);
  const d = out.days.find((x) => x.day === '2026-10-15');
  assert.equal(d.coverage, Math.round(((7200 + DAY / 2) / DAY) * 1000) / 1000);
  assert.equal(out.counting_since, new Date((day + 3600) * 1000).toISOString());
});

test('isPumpFunMint keeps pump.fun tokens and drops other PumpSwap pools', () => {
  const seen = new Map([['BotMadeMint111', 1]]);
  assert.equal(isPumpFunMint('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hrpump', seen), true);
  assert.equal(isPumpFunMint('BotMadeMint111', seen), true); // created while listening
  assert.equal(isPumpFunMint('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', seen), false); // e.g. a tokenized stock
  assert.equal(isPumpFunMint('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', seen), false); // USDC
});
