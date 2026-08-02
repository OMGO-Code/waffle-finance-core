-- Migration: 009_chain_cursors
-- Adds a dedicated per-chain cursor table so the reconciler can track the
-- highest block/ledger/slot it has already processed.
--
-- Previously, getLastProcessedBlock() derived this from MAX(src_lock_block)
-- across orders, which only advances when an order transitions — meaning
-- blocks with no relevant events would never update the cursor, making it
-- impossible to distinguish "processed this block and found nothing" from
-- "never processed this block at all".
--
-- The cursor table stores the last position explicitly, so after a restart
-- the reconciler can correctly compute the gap between the last cursor and
-- the current chain tip and emit actionable metrics.
--
-- `chain` values match the Chain type: 'ethereum', 'stellar', 'solana'.
-- `position` is the last fully-processed block (Ethereum), ledger sequence
-- (Soroban/Stellar), or slot (Solana) as an integer.
-- `updated_at` is a unix timestamp (seconds).
CREATE TABLE IF NOT EXISTS chain_cursors (
    chain       TEXT    PRIMARY KEY CHECK (chain IN ('ethereum', 'stellar', 'solana')),
    position    BIGINT  NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);
