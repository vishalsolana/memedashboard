// Refreshes data/state.json from Bitquery + GeckoTerminal and writes public/data.json.
//
// Env:
//   BITQUERY_TOKEN          Bitquery access token (required unless --skip-bitquery)
//   BITQUERY_URL            GraphQL endpoint (default https://streaming.bitquery.io/graphql)
//   BACKFILL_DAYS           days to backfill on the first run (default 30)
//   TTB_LOOKBACK_DAYS       how far before a bond to look for its create (default 30)
//   MAX_GECKO_CALLS         GeckoTerminal call budget for this run (default 300)
// Flags: --skip-bitquery, --skip-gecko

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Bitquery } from './lib/bitquery.mjs';
import { Gecko, updateHighs } from './lib/gecko.mjs';
import { addBonds, addCreates, buildPublic, DAY, emptyState, nextWindow, prune } from './lib/stats.mjs';

const root = new URL('../', import.meta.url);
const STATE = fileURLToPath(new URL('data/state.json', root));
const PUBLIC = fileURLToPath(new URL('public/data.json', root));

const args = new Set(process.argv.slice(2));
const env = process.env;
const now = () => Math.floor(Date.now() / 1000);
const fmt = (ts) => new Date(ts * 1000).toISOString();

async function main() {
  const state = await loadState();

  if (!args.has('--skip-bitquery')) {
    if (!env.BITQUERY_TOKEN) throw new Error('BITQUERY_TOKEN is required (or pass --skip-bitquery)');
    const bq = new Bitquery({ token: env.BITQUERY_TOKEN, url: env.BITQUERY_URL || undefined });
    const { since, till } = nextWindow(state.cursor, now(), Number(env.BACKFILL_DAYS ?? 30));
    console.log(`bitquery: window ${fmt(since)} -> ${fmt(till)}`);

    // Fetch everything first, then merge, so a failed run leaves state untouched
    // and the next run retries the same window.
    const creates = await bq.createsPerDay(since, till);
    const bonds = await bq.migrations(since, till);
    const lookback = Number(env.TTB_LOOKBACK_DAYS ?? 30) * DAY;
    const earliest = Math.min(...bonds.map((b) => b.bonded_at), till);
    const created = await bq.createTimes(bonds.map((b) => b.mint), earliest - lookback);

    addCreates(state, creates);
    addBonds(state, bonds);
    for (const [mint, at] of created) state.tokens[mint].created_at = at;
    state.cursor = fmt(till);
    console.log(
      `bitquery: ${creates.reduce((a, r) => a + r.created, 0)} creates, ${bonds.length} bonds, ${created.size} create times`,
    );
  }

  prune(state, now());

  if (!args.has('--skip-gecko')) {
    const gecko = new Gecko({ budget: Number(env.MAX_GECKO_CALLS ?? 300) });
    // Save progress even if GeckoTerminal fails midway; highs are retried next run.
    try {
      const r = await updateHighs(state, gecko, now());
      console.log(`gecko: ${r.done} highs updated, ${r.queued} queued, ${gecko.calls} calls`);
    } catch (err) {
      console.log(`::warning::gecko stopped early, will retry next run: ${err.message}`);
    }
  }

  await writeFile(STATE, JSON.stringify(state) + '\n');
  await writeFile(PUBLIC, JSON.stringify(buildPublic(state, now())) + '\n');
  console.log(`wrote ${Object.keys(state.tokens).length} tokens, ${Object.keys(state.days).length} days`);
}

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(STATE, 'utf8'));
    // State from the earlier Dune version has no cursor; start fresh.
    return saved.version === 2 ? saved : emptyState();
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
