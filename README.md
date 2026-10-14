# Pump.fun daily dashboard

A static dashboard that tracks, per UTC day over the last 30 days:

- **Tokens created** on pump.fun
- **Tokens bonded**: the bonding curve filled and the token migrated to PumpSwap, counted on the day it happened
- **Bond rate**: bonded ÷ created, same day
- **Time to bond**: bond time − create time (median, p25–p75, average)
- **High of bonded tokens**: peak market cap in the first 24h after bonding (median, p25–p75, average), plus the top 10 per day

No server and no database. A GitHub Action refreshes the data every 3 hours and commits it,
and Vercel serves the `public/` folder.

```
GitHub Actions (every 3h)
  ├─ Bitquery      → daily creates + bonded tokens   (scripts/lib/bitquery.mjs)
  ├─ Solana RPC    → create time of slow bonders     (scripts/lib/rpc.mjs)
  ├─ GeckoTerminal → 24h post-bond peak per token    (free, no key)
  └─ commits data/state.json + public/data.json
        ↓ push
Vercel → static site in public/ reads data.json
```

## Setup

### 1. Bitquery token
1. Sign up at [bitquery.io](https://bitquery.io).
2. Create an access token at [account.bitquery.io → API v2 → Access tokens](https://account.bitquery.io/user/api_v2/access_tokens).
3. **Test the queries first** in the [Bitquery IDE](https://ide.bitquery.io). Paste in each query
   from `scripts/lib/bitquery.mjs` (`CREATES_PER_DAY`, `MIGRATIONS`, `CREATES_FOR_MINTS`), replace
   `$DATASET` with `realtime`, and use variables covering the last few hours, like:
   ```json
   {"since": "2026-10-14T06:00:00Z", "till": "2026-10-14T09:00:00Z", "limit": 10, "offset": 0}
   ```
   Check how many points each query used.

**The free plan only allows the `realtime` dataset** (recent data), so there's no backfill. History
fills in from the first run, and the first full UTC day appears the day after you start. On a paid
plan, set the repo variable `BITQUERY_DATASET` = `combined` and `BACKFILL_DAYS` = `30` to backfill.
Runs must not stop for longer than realtime keeps data, or that gap is under-counted.

### 2. GitHub
In the repo settings → *Secrets and variables* → *Actions*:
- Secret `BITQUERY_TOKEN`: your Bitquery access token
- Secret `SOLANA_RPC_URL` (optional but recommended): a free [Helius](https://helius.dev) RPC URL
  (`https://mainnet.helius-rpc.com/?api-key=…`). Without it the script uses the public Solana RPC,
  which often rate-limits GitHub's servers.

Also set *Settings → Actions → General → Workflow permissions* to **Read and write**.

Scheduled workflows only run on the **default branch**. Run *Actions → Update data → Run workflow*
once by hand. The first run backfills. Raise `max_gecko_calls` (e.g. to `3000`) for that run so
the highs fill in faster. Otherwise they fill in over the next few scheduled runs, newest days first.

### 3. Vercel
Import the repo in Vercel. No framework and no build command are needed: `vercel.json`
serves `public/`. Each data commit triggers a redeploy, which is about 8 a day.

## Local

```sh
npm test                                  # stats unit tests
BITQUERY_TOKEN=… npm run update
npm run dev                               # serve public/ on localhost
```

`node scripts/update.mjs --skip-bitquery` refreshes highs only. `--skip-gecko` refreshes Bitquery only.

## How the numbers are computed

- **Created**: successful `create` and `create_v2` instructions on the pump.fun program
  (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`), counted per UTC day. Each run fetches only the
  window since the previous run (minus the newest 10 minutes) and adds it on. Windows never
  overlap, and a failed run retries the same window.
- **Bonded**: the pump.fun `migrate` instruction, which moves a filled curve to PumpSwap. It
  follows the curve filling within seconds.
- **Time to bond**: the create time comes from Bitquery when realtime still holds it. Otherwise it
  comes from Solana RPC: the oldest transaction on the mint, walking back from the bond. Tokens with
  more than 30,000 pre-bond transactions are skipped and left out of the time stats (`ttb_unknown`).
- **High**: highest 15-minute candle (USD) from GeckoTerminal for the token's PumpSwap pool, from
  bond time to bond + 24h, × 1B supply. A day's highs are marked *settling* until every token
  bonded that day has passed its 24h window. A single spike trade can set a token's high, which
  is why the dashboard leads with the median.
- Days are UTC. The latest numbers lag by up to about 4 hours.

## Costs and limits

- **Bitquery**: per run, one aggregate query for creates, one paged query for migrations, and
  one query per 50 bonded tokens for create times. Watch your points usage after the first few
  days. If it's too high, change the cron in `.github/workflows/update-data.yml` to every 4–6 hours
  (each run then covers a longer window with the same number of queries).
- **Solana RPC**: up to 400 `getSignaturesForAddress` calls per run (`MAX_RPC_CALLS`), usually
  1–3 per bonded token. That fits a free Helius plan.
- **GeckoTerminal**: free API, about 30 calls/min. The script spaces calls 2.2s apart and stops
  at `MAX_GECKO_CALLS` per run.
- **Vercel Hobby** is for non-commercial use. A commercial public dashboard needs a Pro plan
  or another static host (Cloudflare Pages, GitHub Pages).
