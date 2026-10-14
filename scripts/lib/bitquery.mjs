// Bitquery (GraphQL, Solana V2 schema) client for pump.fun creates and migrations.
// Docs: https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/
//
// Auth: an OAuth access token from https://account.bitquery.io/user/api_v2/access_tokens
// sent as "Authorization: Bearer <token>".

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DEFAULT_URL = 'https://streaming.bitquery.io/graphql';
const PAGE = 1000;
const MINT_BATCH = 50;

// Tokens created per UTC day inside [since, till).
export const CREATES_PER_DAY = `
query CreatesPerDay($since: DateTime!, $till: DateTime!) {
  Solana(dataset: combined) {
    Instructions(
      where: {
        Instruction: {Program: {Address: {is: "${PUMP_PROGRAM}"}, Method: {in: ["create", "create_v2"]}}}
        Transaction: {Result: {Success: true}}
        Block: {Time: {since: $since, till: $till}}
      }
    ) {
      Block { Time(interval: {in: days, count: 1}) }
      count
    }
  }
}`;

// Bonded tokens: pump.fun's migrate instruction moves a filled curve to PumpSwap.
export const MIGRATIONS = `
query Migrations($since: DateTime!, $till: DateTime!, $limit: Int!, $offset: Int!) {
  Solana(dataset: combined) {
    Instructions(
      where: {
        Instruction: {Program: {Address: {is: "${PUMP_PROGRAM}"}, Method: {is: "migrate"}}}
        Transaction: {Result: {Success: true}}
        Block: {Time: {since: $since, till: $till}}
      }
      orderBy: {ascending: Block_Time}
      limit: {count: $limit, offset: $offset}
    ) {
      Block { Time }
      Instruction { Accounts { Address } }
    }
  }
}`;

// Create time for a batch of mints (mint is the first account of create/create_v2).
export const CREATES_FOR_MINTS = `
query CreatesForMints($mints: [String!], $since: DateTime!) {
  Solana(dataset: combined) {
    Instructions(
      where: {
        Instruction: {
          Program: {Address: {is: "${PUMP_PROGRAM}"}, Method: {in: ["create", "create_v2"]}}
          Accounts: {includes: {Address: {in: $mints}}}
        }
        Transaction: {Result: {Success: true}}
        Block: {Time: {since: $since}}
      }
      limit: {count: ${MINT_BATCH * 2}}
    ) {
      Block { Time }
      Instruction { Accounts { Address } }
    }
  }
}`;

export class Bitquery {
  constructor({ token, url = DEFAULT_URL, log = console.log }) {
    this.token = token;
    this.url = url;
    this.log = log;
  }

  async query(query, variables) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`bitquery: ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    if (body.errors?.length) throw new Error(`bitquery: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  }

  // -> [{ day: 'YYYY-MM-DD', created: n }]
  async createsPerDay(since, till) {
    const data = await this.query(CREATES_PER_DAY, { since: iso(since), till: iso(till) });
    return (data.Solana?.Instructions ?? []).map((r) => ({
      day: String(r.Block.Time).slice(0, 10),
      created: Number(r.count),
    }));
  }

  // -> [{ mint, bonded_at }], earliest migration per mint
  async migrations(since, till) {
    const out = new Map();
    for (let offset = 0; ; offset += PAGE) {
      const data = await this.query(MIGRATIONS, { since: iso(since), till: iso(till), limit: PAGE, offset });
      const rows = data.Solana?.Instructions ?? [];
      for (const r of rows) {
        const mint = migrateMint(r.Instruction.Accounts.map((a) => a.Address));
        const at = toTs(r.Block.Time);
        if (mint && !(out.get(mint) <= at)) out.set(mint, at);
      }
      if (rows.length < PAGE) break;
    }
    this.log(`bitquery: ${out.size} migrations`);
    return [...out].map(([mint, bonded_at]) => ({ mint, bonded_at }));
  }

  // -> Map(mint -> created_at) for the mints whose create was found after `since`
  async createTimes(mints, since) {
    const found = new Map();
    for (let i = 0; i < mints.length; i += MINT_BATCH) {
      const batch = mints.slice(i, i + MINT_BATCH);
      const data = await this.query(CREATES_FOR_MINTS, { mints: batch, since: iso(since) });
      for (const r of data.Solana?.Instructions ?? []) {
        const mint = r.Instruction.Accounts[0]?.Address;
        const at = toTs(r.Block.Time);
        if (batch.includes(mint) && !(found.get(mint) <= at)) found.set(mint, at);
      }
    }
    return found;
  }
}

// migrate accounts: global, withdraw_authority, mint, bonding_curve, ... Most
// pump.fun mints are vanity addresses ending in "pump"; prefer that, else index 2.
export function migrateMint(accounts) {
  return accounts.find((a) => a?.endsWith('pump')) ?? accounts[2] ?? null;
}

const iso = (ts) => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const toTs = (t) => Math.floor(Date.parse(t) / 1000);
