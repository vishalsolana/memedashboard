// Refreshes data/state.json from Dune + GeckoTerminal and writes public/data.json.
//
// Env:
//   DUNE_API_KEY      Dune API key (required unless --skip-dune)
//   DUNE_QUERY_ID     id of the saved query from queries/pumpfun_daily.sql
//   MAX_GECKO_CALLS   GeckoTerminal call budget for this run (default 300)
//   TTB_LOOKBACK_DAYS how far back to look for a bonded token's create (default 30)
// Flags: --skip-dune, --skip-gecko

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runQuery } from './lib/dune.mjs';
import { Gecko, updateHighs } from './lib/gecko.mjs';
import { buildPublic, daysToScan, emptyState, mergeDuneRows, prune } from './lib/stats.mjs';

const root = new URL('../', import.meta.url);
const STATE = fileURLToPath(new URL('data/state.json', root));
const PUBLIC = fileURLToPath(new URL('public/data.json', root));

const args = new Set(process.argv.slice(2));
const env = process.env;

async function main() {
  const state = await loadState();
  const now = () => Math.floor(Date.now() / 1000);

  if (!args.has('--skip-dune')) {
    if (!env.DUNE_API_KEY || !env.DUNE_QUERY_ID) {
      throw new Error('DUNE_API_KEY and DUNE_QUERY_ID are required (or pass --skip-dune)');
    }
    const days = daysToScan(state.last_dune_sync, now());
    console.log(`dune: scanning ${days} days`);
    const rows = await runQuery({
      apiKey: env.DUNE_API_KEY,
      queryId: env.DUNE_QUERY_ID,
      params: { days, ttb_lookback_days: Number(env.TTB_LOOKBACK_DAYS ?? 30) },
    });
    const merged = mergeDuneRows(state, rows);
    console.log(`dune: merged ${merged.days} day rows, ${merged.bonds} bonded tokens`);
    state.last_dune_sync = new Date().toISOString();
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
    return { ...emptyState(), ...JSON.parse(await readFile(STATE, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
