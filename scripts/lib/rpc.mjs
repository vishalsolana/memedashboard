// Solana JSON-RPC fallback for create times Bitquery's realtime dataset no longer
// holds: the oldest transaction touching a mint is the one that created it.

const DEFAULT_URL = 'https://api.mainnet-beta.solana.com';
const PAGE = 1000;
const MAX_PAGES = 30; // tokens with more pre-bond transactions than this are skipped
const MIN_INTERVAL_MS = 250;

export class SolanaRpc {
  constructor({ url = DEFAULT_URL, budget = 400, log = console.log }) {
    this.url = url;
    this.budget = budget;
    this.calls = 0;
    this.last = 0;
    this.log = log;
  }

  get exhausted() {
    return this.calls >= this.budget;
  }

  async call(method, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.calls++;
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(10000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`rpc: ${res.status} ${method}`);
      const body = await res.json();
      if (body.error) throw new Error(`rpc: ${method}: ${body.error.message}`);
      return body.result;
    }
  }

  // Unix time of the mint's first transaction, walking back from `before`
  // (the bond signature, which skips everything after the bond).
  // Returns undefined when the budget runs out mid-walk, null when it gives up.
  async createTime(mint, before = null) {
    let oldest = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (this.exhausted) return undefined;
      const opts = { limit: PAGE, commitment: 'finalized' };
      if (before) opts.before = before;
      const sigs = await this.call('getSignaturesForAddress', [mint, opts]);
      if (sigs.length) oldest = sigs[sigs.length - 1];
      if (sigs.length < PAGE) return oldest?.blockTime ?? null;
      before = oldest.signature;
    }
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
