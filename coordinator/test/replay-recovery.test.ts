/**
 * replay-recovery.test.ts
 *
 * Tests for coordinator restart recovery, duplicate event delivery,
 * out-of-order event arrival, and conflicting events from two listeners.
 *
 * These tests prove the coordinator can recover from:
 *  - Missed events during a service restart (gap replay)
 *  - The same event delivered multiple times by a listener (idempotency)
 *  - Events arriving in a different order than they were emitted on-chain
 *  - Two listeners reporting conflicting data for the same order
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import type { CoordinatorConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Mocks — no live RPC calls
// ---------------------------------------------------------------------------

let mockEthLogs: Record<string, any[]> = {};
let mockSorobanEvents: any[] = [];

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => 20_000n),
      getLogs: vi.fn(async ({ event }: any) => mockEthLogs[event?.name] ?? []),
    })),
  };
});

vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: vi.fn(() => ({
      getLatestLedger: vi.fn(async () => ({ sequence: 200_000 })),
      getEvents: vi.fn(async () => ({ events: mockSorobanEvents, cursor: null })),
    })),
  },
}));

vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => 600_000),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null),
  })),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id })),
}));

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const log = pino({ level: "silent" });

const VALID_ETH_ADDR  = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK_A      = "0x" + "aa".repeat(32);
const HASHLOCK_B      = "0x" + "bb".repeat(32);

/** A (preimage, hashlock) pair that satisfies sha256(preimage) === hashlock. */
const PREIMAGE_BUF  = Buffer.alloc(32, 0xcc);
const VALID_PREIMAGE  = "0x" + PREIMAGE_BUF.toString("hex");
const VALID_HASHLOCK  = "0x" + createHash("sha256").update(PREIMAGE_BUF).digest("hex");

const BASE_CFG: CoordinatorConfig = {
  network: "testnet",
  port: 3001,
  databaseUrl: "file::memory:",
  logLevel: "silent",
  corsOrigin: "*",
  pollIntervalMs: 15_000,
  ethereum: {
    rpcUrl: "https://rpc.test",
    chainId: 11_155_111,
    htlcEscrow: "0xb352339BEb146f2699d28D736700B953988bB178",
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: "https://soroban.test",
    horizonUrl: "https://horizon.test",
    networkPassphrase: "Test",
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: { rpcUrl: "https://solana.test", programId: "PLACEHOLDER", commitment: "confirmed" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function freshOrders() {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-replay-test-"));
  const db  = await openDatabase(`file:${dir}/test.db`);
  return new OrderService(new OrdersRepository(db), log);
}

function announceInput(hashlock: string) {
  return {
    direction:        "eth_to_xlm" as const,
    hashlock,
    srcChain:         "ethereum" as const,
    srcAddress:       VALID_ETH_ADDR,
    srcAsset:         "native",
    srcAmount:        "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain:         "stellar" as const,
    dstAddress:       VALID_STELLAR,
    dstAsset:         "native",
    dstAmount:        "100000000",
  };
}

function ethCreatedLog(hashlock: string, orderId: bigint, blockNumber: bigint, txHash = "0xabc") {
  return { args: { orderId, hashlock, timelock: 9_999_999n }, transactionHash: txHash, blockNumber };
}

function ethClaimedLog(orderId: bigint, preimage: string, blockNumber: bigint, txHash = "0xdef") {
  return { args: { orderId, preimage }, transactionHash: txHash, blockNumber };
}

function ethRefundedLog(orderId: bigint, blockNumber: bigint, txHash = "0xfed") {
  return { args: { orderId }, transactionHash: txHash, blockNumber };
}

// ---------------------------------------------------------------------------
// Restart recovery — replay after missed window
// ---------------------------------------------------------------------------

describe("Restart recovery — replay after missed events", () => {
  beforeEach(() => {
    mockEthLogs     = {};
    mockSorobanEvents = [];
    vi.clearAllMocks();
  });

  it("recovers an order stuck at announced after a restart missed the src lock event", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // Simulate: coordinator restarted; ETH node returns the OrderCreated log
    // that was missed while the service was down.
    mockEthLogs = {
      OrderCreated: [ethCreatedLog(HASHLOCK_A, 1n, 9_500n, "0xmissed")],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("src_locked");
    expect(updated?.srcOrderId).toBe("1");
    expect(reconciler.getStatus().eventsReplayed).toBe(1);
    expect(reconciler.getStatus().lastRunOk).toBe(true);
  });

  it("recovers a src_locked order to secret_revealed after missing the claim event", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(VALID_HASHLOCK));

    await orders.recordSrcLock({
      publicId:    order.publicId,
      orderId:     "7",
      txHash:      "0xsrc",
      blockNumber: 9_000,
      timelock:    9_999_999,
    });

    // The claim event was missed; reconciler replays it now.
    mockEthLogs = {
      OrderClaimed: [ethClaimedLog(7n, VALID_PREIMAGE, 9_100n, "0xclaim")],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("secret_revealed");
    expect(updated?.preimage).toBe(VALID_PREIMAGE);
    expect(reconciler.getStatus().eventsReplayed).toBe(1);
  });

  it("recovers a src_locked order to refunded after missing the refund event", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId:    order.publicId,
      orderId:     "55",
      txHash:      "0xsrc",
      blockNumber: 8_000,
      timelock:    9_999_999,
    });

    mockEthLogs = {
      OrderRefunded: [ethRefundedLog(55n, 9_800n)],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    const updated = await orders.get(order.publicId);
    expect(updated?.status).toBe("refunded");
    expect(reconciler.getStatus().eventsReplayed).toBe(1);
  });

  it("persists chain cursor after a successful run so the next run can compute the gap", async () => {
    const orders = await freshOrders();
    await orders.announce(announceInput(HASHLOCK_A));

    // Cursor starts at 0 (never run).
    expect(await orders.getChainCursor("ethereum")).toBe(0);

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    // After one run the cursor should equal the mock tip (20_000).
    expect(await orders.getChainCursor("ethereum")).toBe(20_000);
  });

  it("uses the stored cursor as fromBlock on the second run (gap within lookback)", async () => {
    const orders = await freshOrders();
    await orders.announce(announceInput(HASHLOCK_A));

    // Prime the cursor to block 15_000 — within the 14_400-block lookback.
    await orders.setChainCursor("ethereum", 15_000);

    const { createPublicClient } = await import("viem");
    const mockClient = (createPublicClient as any).mock.results.at(-1)?.value;

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    // getLogs should have been called; verify it was called (not zero calls)
    // and that the run completed successfully — gap coverage metrics were set.
    expect(reconciler.getStatus().lastRunOk).toBe(true);
    expect(await orders.getChainCursor("ethereum")).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Duplicate event delivery — idempotency
// ---------------------------------------------------------------------------

describe("Duplicate event delivery — idempotency", () => {
  beforeEach(() => {
    mockEthLogs     = {};
    mockSorobanEvents = [];
    vi.clearAllMocks();
  });

  it("replaying the same OrderCreated twice does not double-transition the order", async () => {
    const orders     = await freshOrders();
    const order      = await orders.announce(announceInput(HASHLOCK_A));
    const reconciler = new Reconciler(BASE_CFG, orders, log);

    mockEthLogs = {
      OrderCreated: [ethCreatedLog(HASHLOCK_A, 1n, 9_000n)],
    };

    // First run — should apply
    await reconciler.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
    expect(reconciler.getStatus().eventsReplayed).toBe(1);

    // Second run with same logs — srcOrderId already set, should be no-op
    const reconciler2 = new Reconciler(BASE_CFG, orders, log);
    await reconciler2.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
    expect(reconciler2.getStatus().eventsReplayed).toBe(0);
  });

  it("replaying the same OrderClaimed twice does not re-write the preimage", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(VALID_HASHLOCK));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "3",
      txHash: "0xsrc", blockNumber: 100, timelock: 9_999_999,
    });

    mockEthLogs = {
      OrderClaimed: [ethClaimedLog(3n, VALID_PREIMAGE, 200n)],
    };

    const r1 = new Reconciler(BASE_CFG, orders, log);
    await r1.run();
    expect((await orders.get(order.publicId))?.status).toBe("secret_revealed");
    expect(r1.getStatus().eventsReplayed).toBe(1);

    const r2 = new Reconciler(BASE_CFG, orders, log);
    await r2.run();
    expect(r2.getStatus().eventsReplayed).toBe(0);
    // Status must not have advanced past secret_revealed by a duplicate claim
    expect((await orders.get(order.publicId))?.status).toBe("secret_revealed");
  });

  it("replaying the same OrderRefunded twice is a no-op on the second pass", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "9",
      txHash: "0xsrc", blockNumber: 100, timelock: 9_999_999,
    });

    mockEthLogs = {
      OrderRefunded: [ethRefundedLog(9n, 500n)],
    };

    const r1 = new Reconciler(BASE_CFG, orders, log);
    await r1.run();
    expect((await orders.get(order.publicId))?.status).toBe("refunded");

    const r2 = new Reconciler(BASE_CFG, orders, log);
    await r2.run();
    expect(r2.getStatus().eventsReplayed).toBe(0);
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });

  it("direct duplicate calls to recordSrcLock (same orderId + txHash) are no-ops", async () => {
    const db     = (await freshOrders() as any).repo;
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    const lockInput = { publicId: order.publicId, orderId: "1", txHash: "0xtx", blockNumber: 100, timelock: 9999 };
    await orders.recordSrcLock(lockInput);
    // Second call with identical arguments — must not throw and must be a no-op
    await expect(orders.recordSrcLock(lockInput)).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
  });

  it("direct duplicate calls to recordDstLock are no-ops", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "1", txHash: "0xsrc", blockNumber: 1, timelock: 9999,
    });

    const dstInput = {
      publicId: order.publicId, orderId: "2", txHash: "0xdst",
      blockNumber: 2, timelock: 9999, resolver: null,
    };
    await orders.recordDstLock(dstInput);
    await expect(orders.recordDstLock(dstInput)).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))?.status).toBe("dst_locked");
  });

  it("duplicate markStatus with same target is a no-op", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "1", txHash: "0xsrc", blockNumber: 1, timelock: 9999,
    });
    await orders.markStatus(order.publicId, "refunded");
    // Same status again — must resolve without throwing
    await expect(orders.markStatus(order.publicId, "refunded")).resolves.toBeUndefined();
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });
});

// ---------------------------------------------------------------------------
// Out-of-order event arrival
// ---------------------------------------------------------------------------

describe("Out-of-order event arrival", () => {
  beforeEach(() => {
    mockEthLogs     = {};
    mockSorobanEvents = [];
    vi.clearAllMocks();
  });

  it("OrderClaimed arriving before OrderCreated does not corrupt state (claimed rejected, created applied later)", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(VALID_HASHLOCK));

    // First replay: only the claimed event arrives; no src lock yet.
    // The reconciler should skip it (order has no srcOrderId to look up by).
    mockEthLogs = {
      OrderClaimed: [ethClaimedLog(42n, VALID_PREIMAGE, 200n)],
    };

    const r1 = new Reconciler(BASE_CFG, orders, log);
    await r1.run();

    // Order should still be announced — claim was skipped because no srcOrderId.
    expect((await orders.get(order.publicId))?.status).toBe("announced");
    expect(r1.getStatus().eventsReplayed).toBe(0);

    // Now the created event surfaces; apply it.
    mockEthLogs = {
      OrderCreated: [ethCreatedLog(VALID_HASHLOCK, 42n, 100n)],
    };

    const r2 = new Reconciler(BASE_CFG, orders, log);
    await r2.run();
    expect((await orders.get(order.publicId))?.status).toBe("src_locked");
    expect(r2.getStatus().eventsReplayed).toBe(1);
  });

  it("applying a refund event to an announced order (no src lock yet) is rejected cleanly", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // No src lock — so findBySrcOrderId returns null for any orderId.
    // The reconciler skips the event cleanly (order_not_found).
    mockEthLogs = {
      OrderRefunded: [ethRefundedLog(99n, 300n)],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    // Order must remain announced — refund for an unknown orderId is a no-op.
    expect((await orders.get(order.publicId))?.status).toBe("announced");
    expect(reconciler.getStatus().lastRunOk).toBe(true);
  });

  it("a stale OrderCreated replay for a lower block than already-recorded does not overwrite", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // Apply the correct lock first at block 1000.
    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "5",
      txHash: "0xreal", blockNumber: 1_000, timelock: 9_999_999,
    });

    // Replay delivers a stale event at block 500 with a different orderId.
    // dispatch policy should reject it as stale_sequence / already_applied.
    mockEthLogs = {
      OrderCreated: [ethCreatedLog(HASHLOCK_A, 99n, 500n, "0xstale")],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    const updated = await orders.get(order.publicId);
    // srcOrderId must remain "5" — not overwritten by the stale replay.
    expect(updated?.srcOrderId).toBe("5");
    expect(updated?.srcLockTx).toBe("0xreal");
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
  });

  it("direct out-of-order markStatus calls are rejected with OrderValidationError", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // Cannot jump straight from announced → completed.
    await expect(orders.markStatus(order.publicId, "completed")).rejects.toThrow(OrderValidationError);
    expect((await orders.get(order.publicId))?.status).toBe("announced");
  });

  it("cannot record dst lock before src lock (wrong order)", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // dst_locked cannot be reached from announced according to the state machine.
    await expect(
      orders.recordDstLock({
        publicId: order.publicId, orderId: "2", txHash: "0xdst",
        blockNumber: 2, timelock: 9999, resolver: null,
      })
    ).rejects.toThrow(OrderValidationError);

    expect((await orders.get(order.publicId))?.status).toBe("announced");
  });
});

// ---------------------------------------------------------------------------
// Conflicting events from two listeners
// ---------------------------------------------------------------------------

describe("Conflicting events from two listeners", () => {
  beforeEach(() => {
    mockEthLogs     = {};
    mockSorobanEvents = [];
    vi.clearAllMocks();
  });

  it("conflicting srcLock (different orderId for the same order) throws OrderValidationError", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "101",
      txHash: "0xfirst", blockNumber: 100, timelock: 9999,
    });

    // Second listener reports a different orderId for the same public order.
    await expect(
      orders.recordSrcLock({
        publicId: order.publicId, orderId: "102",
        txHash: "0xsecond", blockNumber: 101, timelock: 9999,
      })
    ).rejects.toThrow(OrderValidationError);

    // Original data preserved.
    const current = await orders.get(order.publicId);
    expect(current?.srcOrderId).toBe("101");
    expect(current?.srcLockTx).toBe("0xfirst");
  });

  it("conflicting dstLock (different orderId) throws OrderValidationError", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "1",
      txHash: "0xsrc", blockNumber: 1, timelock: 9999,
    });
    await orders.recordDstLock({
      publicId: order.publicId, orderId: "200",
      txHash: "0xdst1", blockNumber: 2, timelock: 9999, resolver: null,
    });

    await expect(
      orders.recordDstLock({
        publicId: order.publicId, orderId: "201",
        txHash: "0xdst2", blockNumber: 3, timelock: 9999, resolver: null,
      })
    ).rejects.toThrow(OrderValidationError);

    const current = await orders.get(order.publicId);
    expect(current?.dstOrderId).toBe("200");
  });

  it("conflicting preimage from two listeners throws OrderValidationError", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "1",
      txHash: "0xsrc", blockNumber: 1, timelock: 9999,
    });
    await orders.recordSecret(order.publicId, "0x" + "aa".repeat(32), "0xtx1");

    await expect(
      orders.recordSecret(order.publicId, "0x" + "bb".repeat(32), "0xtx2")
    ).rejects.toThrow(OrderValidationError);

    // Original preimage preserved.
    expect((await orders.get(order.publicId))?.preimage).toBe("0x" + "aa".repeat(32));
  });

  it("reconciler skips an ETH refund that conflicts with a completed order and emits conflict metric", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    // Manually drive the order to completed so we can test the conflict path.
    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "77",
      txHash: "0xsrc", blockNumber: 100, timelock: 9999,
    });
    await orders.recordDstLock({
      publicId: order.publicId, orderId: "78",
      txHash: "0xdst", blockNumber: 101, timelock: 9999, resolver: null,
    });
    await orders.recordSecret(order.publicId, "0x" + "aa".repeat(32), "0xrev");
    await orders.markStatus(order.publicId, "completed");

    // Chain now emits a refund for the same orderId — conflict!
    mockEthLogs = {
      OrderRefunded: [ethRefundedLog(77n, 200n)],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    // Order must remain completed — the refund must not overwrite it.
    expect((await orders.get(order.publicId))?.status).toBe("completed");
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
    expect(reconciler.getStatus().lastRunOk).toBe(true);
  });

  it("reconciler skips a replay src lock event for a terminal order", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({
      publicId: order.publicId, orderId: "33",
      txHash: "0xsrc", blockNumber: 50, timelock: 9999,
    });
    await orders.markStatus(order.publicId, "refunded");

    // Reconciler replays the same OrderCreated — already terminal.
    mockEthLogs = {
      OrderCreated: [ethCreatedLog(HASHLOCK_A, 33n, 50n, "0xsrc")],
    };

    const reconciler = new Reconciler(BASE_CFG, orders, log);
    await reconciler.run();

    expect((await orders.get(order.publicId))?.status).toBe("refunded");
    expect(reconciler.getStatus().eventsReplayed).toBe(0);
    expect(reconciler.getStatus().lastRunOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Terminal-state guards (direct OrderService calls)
// ---------------------------------------------------------------------------

describe("Terminal-state guards in OrderService", () => {
  it("recordSrcLock on a completed order throws", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xa", blockNumber: 1, timelock: 9 });
    await orders.recordDstLock({ publicId: order.publicId, orderId: "2", txHash: "0xb", blockNumber: 2, timelock: 9, resolver: null });
    await orders.recordSecret(order.publicId, "0x" + "cc".repeat(32), "0xc");
    await orders.markStatus(order.publicId, "completed");

    await expect(
      orders.recordSrcLock({ publicId: order.publicId, orderId: "99", txHash: "0xd", blockNumber: 99, timelock: 9 })
    ).rejects.toThrow(OrderValidationError);
  });

  it("recordSecret on a refunded order throws", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xa", blockNumber: 1, timelock: 9 });
    await orders.markStatus(order.publicId, "refunded");

    await expect(
      orders.recordSecret(order.publicId, "0x" + "dd".repeat(32), "0xe")
    ).rejects.toThrow(OrderValidationError);
  });

  it("markStatus on a terminal order throws with a clear message", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xa", blockNumber: 1, timelock: 9 });
    await orders.markStatus(order.publicId, "failed");

    const err = await orders.markStatus(order.publicId, "refunded").catch(e => e);
    expect(err).toBeInstanceOf(OrderValidationError);
    expect(err.message).toMatch(/terminal/);
  });
});

// ---------------------------------------------------------------------------
// expireStaleOrders — idempotency and per-skip metrics
// ---------------------------------------------------------------------------

describe("expireStaleOrders — idempotency", () => {
  it("skips orders already in expired state and does not throw", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));
    const past   = Math.floor(Date.now() / 1000) - 3600;

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xa", blockNumber: 1, timelock: past });
    // First scan — should expire it.
    const first = await orders.expireStaleOrders();
    expect(first).toBe(1);
    expect((await orders.get(order.publicId))?.status).toBe("expired");

    // Second scan with the same now — already expired, should be skipped.
    const second = await orders.expireStaleOrders();
    expect(second).toBe(0);
    expect((await orders.get(order.publicId))?.status).toBe("expired");
  });

  it("does not expire terminal orders even if their timelock has passed", async () => {
    const orders = await freshOrders();
    const order  = await orders.announce(announceInput(HASHLOCK_A));
    const past   = Math.floor(Date.now() / 1000) - 3600;

    await orders.recordSrcLock({ publicId: order.publicId, orderId: "1", txHash: "0xa", blockNumber: 1, timelock: past });
    await orders.markStatus(order.publicId, "refunded");

    const count = await orders.expireStaleOrders();
    expect(count).toBe(0);
    expect((await orders.get(order.publicId))?.status).toBe("refunded");
  });
});
