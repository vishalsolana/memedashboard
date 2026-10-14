import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bitquery } from '../scripts/lib/bitquery.mjs';

function mockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, ...body });
    return new Response(JSON.stringify(responder(body)), { status: 200 });
  };
  return calls;
}

const bq = () => new Bitquery({ token: 'T', log: () => {} });

test('createsPerDay reads day buckets and string counts', async () => {
  const calls = mockFetch(() => ({
    data: { Solana: { Instructions: [{ Block: { Time: '2026-10-13T00:00:00Z' }, count: '23456' }] } },
  }));
  const rows = await bq().createsPerDay(1760000000, 1760010000);
  assert.deepEqual(rows, [{ day: '2026-10-13', created: 23456 }]);
  assert.equal(calls[0].auth, 'Bearer T');
  assert.equal(calls[0].variables.since, '2025-10-09T08:53:20Z');
});

test('migrations pages until a short page and keeps the earliest per mint', async () => {
  const row = (t, mint) => ({ Block: { Time: t }, Instruction: { Accounts: [{ Address: 'G' }, { Address: 'W' }, { Address: mint }] } });
  const calls = mockFetch(({ variables }) => {
    const rows = variables.offset === 0
      ? Array.from({ length: 1000 }, (_, i) => row(`2026-10-13T00:${String(i % 60).padStart(2, '0')}:00Z`, `m${i % 3}pump`))
      : [row('2026-10-12T23:00:00Z', 'm0pump')];
    return { data: { Solana: { Instructions: rows } } };
  });
  const out = await bq().migrations(0, 1);
  assert.equal(calls.length, 2);
  assert.equal(out.length, 3);
  assert.equal(out.find((b) => b.mint === 'm0pump').bonded_at, Date.parse('2026-10-12T23:00:00Z') / 1000);
});

test('createTimes batches mints and ignores unrelated rows', async () => {
  const mints = Array.from({ length: 60 }, (_, i) => `m${i}`);
  const calls = mockFetch(({ variables }) => ({
    data: {
      Solana: {
        Instructions: variables.mints.slice(0, 2).map((m) => ({ Block: { Time: '2026-10-13T00:00:00Z' }, Instruction: { Accounts: [{ Address: m }] } }))
          .concat([{ Block: { Time: '2026-10-13T00:00:00Z' }, Instruction: { Accounts: [{ Address: 'other' }] } }]),
      },
    },
  }));
  const found = await bq().createTimes(mints, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual([...found.keys()], ['m0', 'm1', 'm50', 'm51']);
});

test('GraphQL errors are raised', async () => {
  mockFetch(() => ({ errors: [{ message: 'Cannot query field' }] }));
  await assert.rejects(bq().createsPerDay(0, 1), /Cannot query field/);
});
