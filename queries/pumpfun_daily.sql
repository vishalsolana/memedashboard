-- pump.fun daily creates + bonded tokens (DuneSQL)
--
-- Paste this into a new Dune query, add two Number parameters, save it, and put
-- the query id in the DUNE_QUERY_ID repo variable:
--   {{days}}               whole UTC days to scan, counting today (script sets it)
--   {{ttb_lookback_days}}  extra days to search for a bonded token's create tx
--
-- Reads raw program instructions instead of decoded tables, using the same
-- discriminators as Spellbook's pumpdotfun_solana.base_trades model.
--   create     0x181ec828051c0777  (sha256("global:create")[:8])
--   create_v2  0xd6904cec5f8b31b4  (sha256("global:create_v2")[:8], Token-2022 mints)
--   CompleteEvent = anchor emit_cpi tag 0xe445a52e51cb9a1d + 0x5f72619cd42e9808
--     layout: user(32) mint(32) bonding_curve(32) timestamp(i64)
--
-- Output: one result set, two row kinds.
--   kind = 'day'  -> day, created
--   kind = 'bond' -> mint, created_ts, bonded_ts (unix seconds), pool (PumpSwap)

WITH creates AS (
    SELECT
        account_arguments[1] AS mint,
        MIN(block_time) AS created_at
    FROM solana.instruction_calls
    WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND executing_account_prefix = '6E'
        AND tx_success = true
        AND block_date >= date_add('day', 1 - {{days}} - {{ttb_lookback_days}}, current_date)
        AND bytearray_substring(data, 1, 8) IN (0x181ec828051c0777, 0xd6904cec5f8b31b4)
    GROUP BY 1
),

bonds AS (
    SELECT
        to_base58(bytearray_substring(data, 1 + 16 + 32, 32)) AS mint,
        MIN(block_time) AS bonded_at
    FROM solana.instruction_calls
    WHERE executing_account = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND executing_account_prefix = '6E'
        AND tx_success = true
        AND block_date >= date_add('day', 1 - {{days}}, current_date)
        AND bytearray_substring(data, 1, 16) = 0xe445a52e51cb9a1d5f72619cd42e9808
    GROUP BY 1
),

-- The migration pool is the first PumpSwap pool for the mint after it bonds.
pools AS (
    SELECT
        b.mint,
        min_by(p.pool, p.created_at) AS pool
    FROM bonds b
    JOIN pumpswap_solana.pools p
        ON p.baseMint = b.mint
        AND p.created_at >= b.bonded_at - INTERVAL '1' HOUR
    GROUP BY 1
)

SELECT
    'day' AS kind,
    CAST(CAST(created_at AS date) AS varchar) AS day,
    COUNT(*) AS created,
    CAST(NULL AS varchar) AS mint,
    CAST(NULL AS double) AS created_ts,
    CAST(NULL AS double) AS bonded_ts,
    CAST(NULL AS varchar) AS pool
FROM creates
WHERE created_at >= CAST(date_add('day', 1 - {{days}}, current_date) AS timestamp)
GROUP BY 2

UNION ALL

SELECT
    'bond' AS kind,
    CAST(NULL AS varchar) AS day,
    CAST(NULL AS bigint) AS created,
    b.mint,
    to_unixtime(c.created_at) AS created_ts,
    to_unixtime(b.bonded_at) AS bonded_ts,
    pl.pool
FROM bonds b
LEFT JOIN creates c ON c.mint = b.mint
LEFT JOIN pools pl ON pl.mint = b.mint
