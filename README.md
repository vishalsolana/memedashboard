# Pump.fun daily dashboard

A static dashboard that tracks, per UTC day over the last 30 days:

- **Tokens created** on pump.fun
- **Tokens bonded**: the bonding curve filled (`CompleteEvent`), counted on the day it happened
- **Bond rate**: bonded ÷ created, same day
- **Time to bond**: bond time − create time (median, p25–p75, average)
- **High of bonded tokens**: peak market cap in the first 24h after bonding (median, p25–p75, average), plus the top 10 per day

No server and no database. A GitHub Action refreshes the data every 3 hours and commits it,
and Vercel serves the `public/` folder.

```
GitHub Actions (every 3h)
  ├─ Dune API      → daily creates + bonded tokens   (queries/pumpfun_daily.sql)
  ├─ GeckoTerminal → 24h post-bond peak per token    (free, no key)
  └─ commits data/state.json + public/data.json
        ↓ push
Vercel → static site in public/ reads data.json
```

## Setup

### 1. Dune query
1. Create a free account at [dune.com](https://dune.com) and an API key (Settings → API).
2. Create a new query, paste in `queries/pumpfun_daily.sql`, and add two **Number** parameters:
   `days` (e.g. 3) and `ttb_lookback_days` (30). Run it once to check it works, then save it.
3. Note the query id from the URL (`dune.com/queries/<id>`).

### 2. GitHub
In the repo settings → *Secrets and variables* → *Actions*:
- Secret `DUNE_API_KEY`: your Dune API key
- Variable `DUNE_QUERY_ID`: the query id

Scheduled workflows only run on the **default branch**, so merge this to `main` first. Then
open *Actions → Update data → Run workflow*. The first run backfills 30 days. Raise
`max_gecko_calls` (e.g. to `3000`) for that run so the highs fill in faster. Otherwise they
fill in over the next few scheduled runs, newest days first.

### 3. Vercel
Import the repo in Vercel. No framework and no build command are needed: `vercel.json`
serves `public/`. Each data commit triggers a redeploy, which is about 8 a day.

## Local

```sh
npm test                                  # stats unit tests
DUNE_API_KEY=… DUNE_QUERY_ID=… npm run update
npm run dev                               # serve public/ on localhost
```

`node scripts/update.mjs --skip-dune` refreshes highs only. `--skip-gecko` refreshes Dune only.

## How the numbers are computed

- **Created**: `create` and `create_v2` instructions on the pump.fun program
  (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`), read from `solana.instruction_calls` by
  discriminator. The query does not depend on decoded tables.
- **Bonded**: the program's `CompleteEvent`. Time to bond needs the token's create transaction
  within `ttb_lookback_days`. Older tokens still count as bonded but are left out of the time
  stats (`ttb_unknown`).
- **High**: highest 15-minute candle (USD) from GeckoTerminal for the token's PumpSwap pool, from
  bond time to bond + 24h, × 1B supply. A day's highs are marked *settling* until every token
  bonded that day has passed its 24h window. A single spike trade can set a token's high, which
  is why the dashboard leads with the median.
- Days are UTC. The latest numbers lag by up to about 4 hours.

## Costs and limits

- **Dune**: one execution per run (8 a day) that scans only the days since the last sync.
  Check your plan's credit usage after the first few days. If it's too high, change the
  cron in `.github/workflows/update-data.yml` to every 4–6 hours.
- **GeckoTerminal**: free API, about 30 calls/min. The script spaces calls 2.2s apart and stops
  at `MAX_GECKO_CALLS` per run.
- **Vercel Hobby** is for non-commercial use. A commercial public dashboard needs a Pro plan
  or another static host (Cloudflare Pages, GitHub Pages).
