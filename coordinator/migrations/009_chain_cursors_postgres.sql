-- Migration: 009_chain_cursors (Postgres)
-- Adds a dedicated per-chain cursor table so the reconciler can track the
-- highest block/ledger/slot it has already processed.
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
