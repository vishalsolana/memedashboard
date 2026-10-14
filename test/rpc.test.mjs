import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolanaRpc } from '../scripts/lib/rpc.mjs';

function mockRpc(pages) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const { params } = JSON.parse(init.body);
    calls.push(params[1]);
    return new Response(JSON.stringify({ result: pages[calls.length - 1] ?? [] }));
  };
  return calls;
}

const sigs = (n, from) => Array.from({ length: n }, (_, i) => ({ signature: `s${from + i}`, blockTime: 5000 - from - i }));

test('createTime walks back from the bond signature to the oldest transaction', async () => {
  const calls = mockRpc([sigs(1000, 0), sigs(10, 1000)]);
  const at = await new SolanaRpc({ url: 'x' }).createTime('mint', 'bondSig');
  assert.equal(at, 5000 - 1009);
  assert.equal(calls[0].before, 'bondSig');
  assert.equal(calls[1].before, 's999');
});

test('createTime handles an exact multiple of the page size', async () => {
  mockRpc([sigs(1000, 0), []]);
  assert.equal(await new SolanaRpc({ url: 'x' }).createTime('mint'), 5000 - 999);
});

test('createTime reports a spent budget as undefined', async () => {
  mockRpc([sigs(1000, 0), sigs(1000, 1000)]);
  assert.equal(await new SolanaRpc({ url: 'x', budget: 1 }).createTime('mint'), undefined);
});
