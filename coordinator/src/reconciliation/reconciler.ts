import {
  createPublicClient,
  http,
  parseAbiItem,
  type PublicClient,
  type Log
} from "viem";
import { sepolia, mainnet } from "viem/chains";
import { rpc } from "@stellar/stellar-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Logger } from "pino";
import type { CoordinatorConfig } from "../config.js";
import type { OrderService } from "../services/order-service.js";
import {
  reconciliationRuns,
  reconciliationErrors,
  reconciliationLastRun,
  reconciliationEventsReplayed,
  reconciliationEventsSkipped,
  reconciliationConflicts,
  reconciliationGapBlocks,
  reconciliationLookbackCoverage,
  reconciliationRestartRecoveryEvents,
  sorobanDecodeErrors,
  workflowDispatchDecisions,
} from "../metrics.js";
import { isTerminal } from "../state-machine/order-machine.js";
import { validatePreimage } from "./secret-reconciler.js";
import {
  decodeHtlcEvent,
  isMalformedEvent,
} from "../soroban-events.js";
import { decideDispatch } from "../services/workflow-priority-policy.js";

const ORDER_CREATED = parseAbiItem(
  "event OrderCreated(uint256 indexed orderId, address indexed sender, address indexed beneficiary, address token, uint256 amount, uint256 safetyDeposit, bytes32 hashlock, uint64 timelock)"
);
const ORDER_CLAIMED = parseAbiItem(
  "event OrderClaimed(uint256 indexed orderId, address indexed claimer, bytes32 preimage, uint256 amount, uint256 safetyDeposit)"
);
const ORDER_REFUNDED = parseAbiItem(
  "event OrderRefunded(uint256 indexed orderId, address indexed caller, uint256 amount, uint256 safetyDeposit)"
);

interface SorobanRpcEvent {
  ledger: number;
  txHash: string;
  topic?: xdr.ScVal[];
  value: xdr.ScVal;
}

/** How many Ethereum blocks ~48h covers at ~12s/block (increased from 24h for better recovery) */
const ETH_LOOKBACK_BLOCKS = 14_400n;
/** Soroban ledger lookback (~5s/ledger, 48h) */
const SOROBAN_LOOKBACK_LEDGERS = 34_560;
/** Solana slot lookback (~400ms/slot, 48h) */
const SOLANA_LOOKBACK_SLOTS = 432_000;

export interface ReconciliationStatus {
  lastRunAt: number | null;
  lastRunOk: boolean | null;
  eventsReplayed: number;
}

export class Reconciler {
  private readonly log: Logger;
  private readonly ethClient: PublicClient;
  private readonly sorobanServer: rpc.Server;
  private readonly solanaConn: Connection;

  private status: ReconciliationStatus = {
    lastRunAt: null,
    lastRunOk: null,
    eventsReplayed: 0
  };

  constructor(
    private readonly cfg: CoordinatorConfig,
    private readonly orders: OrderService,
    log: Logger
  ) {
    this.log = log.child({ component: "Reconciler" });
    this.ethClient = createPublicClient({
      chain: cfg.ethereum.chainId === 1 ? mainnet : sepolia,
      transport: http(cfg.ethereum.rpcUrl)
    });
    this.sorobanServer = new rpc.Server(cfg.soroban.rpcUrl, {
      allowHttp: cfg.soroban.rpcUrl.startsWith("http://")
    });
    this.solanaConn = new Connection(cfg.solana.rpcUrl, cfg.solana.commitment);
  }

  getStatus(): ReconciliationStatus {
    return { ...this.status };
  }

  async run(): Promise<void> {
    this.log.info("reconciliation run starting");
    let replayed = 0;

    try {
      replayed += await this.reconcileEthereum();
      replayed += await this.reconcileSoroban();
      replayed += await this.reconcileSolana();

      this.status = { lastRunAt: Date.now(), lastRunOk: true, eventsReplayed: replayed };
      reconciliationRuns.inc({ result: "success" });
      reconciliationEventsReplayed.inc(replayed);
      reconciliationLastRun.set(Date.now() / 1000);
      this.log.info({ replayed }, "reconciliation run complete");
    } catch (err) {
      this.status = { lastRunAt: Date.now(), lastRunOk: false, eventsReplayed: replayed };
      reconciliationRuns.inc({ result: "failure" });
      reconciliationErrors.inc();
      this.log.error({ err }, "reconciliation run failed");
    }
  }

  /**
   * Measure and emit the gap between the persistent cursor and the current
   * chain tip.  Returns the effective fromBlock/fromLedger/fromSlot the
   * reconciler should use — either the cursor position (when the gap is
   * within the lookback window) or tip minus lookback (when the gap is too
   * large to fully cover, which we log as a warning).
   */
  private async computeEthFromBlock(latest: bigint): Promise<bigint> {
    const cursor = await this.orders.getChainCursor("ethereum");
    const tip = Number(latest);
    const gap = tip - cursor;

    reconciliationGapBlocks.set({ chain: "ethereum" }, Math.max(gap, 0));

    const lookback = Number(ETH_LOOKBACK_BLOCKS);
    reconciliationLookbackCoverage.set({ chain: "ethereum" }, Math.min(gap, lookback));

    if (cursor > 0 && gap > lookback) {
      this.log.warn(
        { chain: "ethereum", cursor, tip, gap, lookback },
        "reconciler: gap exceeds lookback window — some events may be permanently missed; " +
        "increase ETH_LOOKBACK_BLOCKS or trigger a full historical replay"
      );
      reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "gap_exceeds_lookback" });
    } else if (cursor > 0) {
      this.log.info({ chain: "ethereum", cursor, tip, gap }, "reconciler: ethereum gap within lookback window");
    }

    // Start from the cursor if it's within the lookback window; otherwise
    // fall back to tip - lookback so we always scan a full window.
    const fromBlock = cursor > 0 && gap <= lookback
      ? BigInt(cursor)
      : (latest > ETH_LOOKBACK_BLOCKS ? latest - ETH_LOOKBACK_BLOCKS : 0n);

    return fromBlock;
  }

  private async computeSorobanFromLedger(latestSeq: number): Promise<number> {
    const cursor = await this.orders.getChainCursor("stellar");
    const gap = latestSeq - cursor;

    reconciliationGapBlocks.set({ chain: "stellar" }, Math.max(gap, 0));

    const lookback = SOROBAN_LOOKBACK_LEDGERS;
    reconciliationLookbackCoverage.set({ chain: "stellar" }, Math.min(gap, lookback));

    if (cursor > 0 && gap > lookback) {
      this.log.warn(
        { chain: "stellar", cursor, tip: latestSeq, gap, lookback },
        "reconciler: Soroban gap exceeds lookback window — some events may be permanently missed"
      );
      reconciliationConflicts.inc({ chain: "stellar", conflict_type: "gap_exceeds_lookback" });
    }

    return cursor > 0 && gap <= lookback
      ? cursor
      : Math.max(0, latestSeq - lookback);
  }

  private async computeSolanaFromSlot(tipSlot: number): Promise<number> {
    const cursor = await this.orders.getChainCursor("solana");
    const gap = tipSlot - cursor;

    reconciliationGapBlocks.set({ chain: "solana" }, Math.max(gap, 0));

    const lookback = SOLANA_LOOKBACK_SLOTS;
    reconciliationLookbackCoverage.set({ chain: "solana" }, Math.min(gap, lookback));

    if (cursor > 0 && gap > lookback) {
      this.log.warn(
        { chain: "solana", cursor, tip: tipSlot, gap, lookback },
        "reconciler: Solana gap exceeds lookback window — some events may be permanently missed"
      );
      reconciliationConflicts.inc({ chain: "solana", conflict_type: "gap_exceeds_lookback" });
    }

    return cursor > 0 && gap <= lookback
      ? cursor
      : Math.max(0, tipSlot - lookback);
  }

  // ---------------------------------------------------------------------------
  // Ethereum
  // ---------------------------------------------------------------------------

  private async reconcileEthereum(): Promise<number> {
    if (!this.cfg.ethereum.htlcEscrow) return 0;

    const address = this.cfg.ethereum.htlcEscrow;
    const latest = await this.ethClient.getBlockNumber();
    const fromBlock = await this.computeEthFromBlock(latest);

    const [createdLogs, claimedLogs, refundedLogs] = await Promise.all([
      this.ethClient.getLogs({ address, event: ORDER_CREATED, fromBlock, toBlock: latest }),
      this.ethClient.getLogs({ address, event: ORDER_CLAIMED, fromBlock, toBlock: latest }),
      this.ethClient.getLogs({ address, event: ORDER_REFUNDED, fromBlock, toBlock: latest })
    ]);

    let replayed = 0;
    replayed += await this.replayEthCreated(createdLogs);
    replayed += await this.replayEthClaimed(claimedLogs);
    replayed += await this.replayEthRefunded(refundedLogs);

    // Persist cursor so the next run knows where we got to.
    await this.orders.setChainCursor("ethereum", Number(latest));
    return replayed;
  }

  private async replayEthCreated(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as {
        orderId: bigint;
        hashlock: `0x${string}`;
        timelock: bigint;
      };
      if (!args?.hashlock) continue;
      try {
        const order = await this.orders.findByHashlock(args.hashlock);
        if (!order) {
          // Chain has an event for an order we have no announcement for.
          // This is normal for orders announced by other clients; emit a
          // debug log rather than a warning.
          this.log.debug({ hashlock: args.hashlock }, "reconciler: ETH OrderCreated for unknown order — skipping");
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: Number(log.blockNumber ?? 0n),
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          // Conflict detection: chain shows a created event but DB is already
          // terminal — this indicates the order completed/refunded in a prior
          // session and is expected during replay of old history.
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "chain_ahead" });
            this.log.info(
              { publicId: order.publicId, status: order.status, hashlock: args.hashlock },
              "reconciler: ETH OrderCreated skipped — order already terminal (expected after refund/complete)"
            );
          }
          continue;
        }

        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: args.orderId.toString(),
          txHash: log.transactionHash ?? "0x",
          blockNumber: Number(log.blockNumber ?? 0n),
          timelock: Number(args.timelock)
        });
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ hashlock: args.hashlock }, "reconciler: replayed ETH OrderCreated");
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          continue;
        }
        this.log.warn({ err, hashlock: args.hashlock }, "reconciler: ETH created replay error");
      }
    }
    return n;
  }

  private async replayEthClaimed(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId: bigint; preimage: `0x${string}` };
      if (!args?.orderId || !args?.preimage) continue;
      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: Number(log.blockNumber ?? 0n),
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          continue;
        }

        if (!validatePreimage(args.preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "terminal_clash" });
          this.log.warn(
            { orderId: args.orderId.toString(), publicId: order.publicId, hashlock: order.hashlock },
            "reconciler: ETH OrderClaimed preimage/hashlock mismatch — chain evidence disagrees with DB record; manual review required"
          );
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "preimage_mismatch" });
          continue;
        }

        await this.orders.recordSecret(order.publicId, args.preimage, log.transactionHash ?? "0x");
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderClaimed");
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          continue;
        }
        this.log.warn({ err }, "reconciler: ETH claimed replay error");
      }
    }
    return n;
  }

  private async replayEthRefunded(logs: Log[]): Promise<number> {
    let n = 0;
    for (const log of logs) {
      const args = (log as any).args as { orderId: bigint };
      if (!args?.orderId) continue;
      try {
        const order = await this.orders.findBySrcOrderId("ethereum", args.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "order_not_found" });
          continue;
        }

        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: Number(log.blockNumber ?? 0n),
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });

        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: decision.reason });
          // DB says completed but chain shows refund — that's an ambiguous conflict.
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "ethereum", conflict_type: "terminal_clash" });
            this.log.error(
              { publicId: order.publicId, orderId: args.orderId.toString() },
              "reconciler: ETH OrderRefunded conflicts with DB status=completed — ambiguous terminal state; manual review required"
            );
          }
          continue;
        }

        await this.orders.markStatus(order.publicId, "refunded");
        n++;
        reconciliationRestartRecoveryEvents.inc({ chain: "ethereum" });
        this.log.info({ orderId: args.orderId.toString() }, "reconciler: replayed ETH OrderRefunded");
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "ethereum", reason: "already_applied" });
          continue;
        }
        this.log.warn({ err }, "reconciler: ETH refunded replay error");
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // Soroban
  // ---------------------------------------------------------------------------

  private async reconcileSoroban(): Promise<number> {
    if (!this.cfg.soroban.htlcContract) return 0;

    const contractId = this.cfg.soroban.htlcContract;
    let replayed = 0;

    try {
      const latest = await this.sorobanServer.getLatestLedger();
      const startLedger = await this.computeSorobanFromLedger(latest.sequence);

      let cursor: string | undefined;
      do {
        const events = await this.sorobanServer.getEvents({
          filters: [{ type: "contract", contractIds: [contractId] }],
          startLedger: cursor ? undefined : startLedger,
          cursor,
          limit: 200
        });

        for (const ev of events.events) {
          replayed += await this.replaySorobanEvent(ev);
        }

        cursor = events.cursor ?? undefined;
        if (events.events.length < 200) break;
      } while (cursor);

      await this.orders.setChainCursor("stellar", latest.sequence);
    } catch (err) {
      this.log.warn({ err }, "reconciler: Soroban fetch failed");
    }

    return replayed;
  }

  private async replaySorobanEvent(ev: any): Promise<number> {
    const result = decodeHtlcEvent(ev.topic ?? [], ev.value);

    if (isMalformedEvent(result)) {
      sorobanDecodeErrors.inc({ reason: result.reason });
      this.log.warn(
        { ledger: ev.ledger, txHash: ev.txHash, kind: result.kind, reason: result.reason },
        "reconciler: Soroban event payload malformed — skipping"
      );
      reconciliationEventsSkipped.inc({ chain: "stellar", reason: "malformed_payload" });
      return 0;
    }

    if (result === null) return 0;

    if (result.kind === "created") {
      try {
        const order = await this.orders.findByHashlock(result.hashlock);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "stellar", conflict_type: "chain_ahead" });
          }
          return 0;
        }
        await this.orders.recordSrcLock({
          publicId: order.publicId,
          orderId: result.orderId.toString(),
          txHash: ev.txHash,
          blockNumber: ev.ledger,
          timelock: result.timelock,
        });
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ hashlock: result.hashlock }, "reconciler: replayed Soroban created");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err, hashlock: result.hashlock }, "reconciler: Soroban created replay error");
        return 0;
      }
    }

    if (result.kind === "claimed") {
      try {
        const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: ev.ledger,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          return 0;
        }
        if (!validatePreimage(result.preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "stellar", conflict_type: "terminal_clash" });
          this.log.warn(
            { orderId: result.orderId.toString(), publicId: order.publicId },
            "reconciler: Soroban claimed preimage/hashlock mismatch — chain evidence disagrees; manual review required"
          );
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "preimage_mismatch" });
          return 0;
        }
        await this.orders.recordSecret(order.publicId, result.preimage, ev.txHash);
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ orderId: result.orderId.toString() }, "reconciler: replayed Soroban claimed");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err }, "reconciler: Soroban claimed replay error");
        return 0;
      }
    }

    if (result.kind === "refunded") {
      try {
        const order = await this.orders.findBySrcOrderId("stellar", result.orderId.toString());
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: ev.ledger,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: decision.reason });
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "stellar", conflict_type: "terminal_clash" });
            this.log.error(
              { publicId: order.publicId, orderId: result.orderId.toString() },
              "reconciler: Soroban OrderRefunded conflicts with DB status=completed — manual review required"
            );
          }
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        reconciliationRestartRecoveryEvents.inc({ chain: "stellar" });
        this.log.info({ orderId: result.orderId.toString() }, "reconciler: replayed Soroban refunded");
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "stellar", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err }, "reconciler: Soroban refunded replay error");
        return 0;
      }
    }

    return 0;
  }

  // ---------------------------------------------------------------------------
  // Solana
  // ---------------------------------------------------------------------------

  private async reconcileSolana(): Promise<number> {
    if (!this.cfg.solana.programId || this.cfg.solana.programId === "PLACEHOLDER") return 0;

    let replayed = 0;
    try {
      const slot = await this.solanaConn.getSlot(this.cfg.solana.commitment);
      const minSlot = await this.computeSolanaFromSlot(slot);
      const programPk = new PublicKey(this.cfg.solana.programId);

      const sigs = await this.solanaConn.getSignaturesForAddress(programPk, {
        limit: 1000,
        minContextSlot: minSlot
      });

      for (const sigInfo of sigs) {
        if (sigInfo.err) continue;
        try {
          const tx = await this.solanaConn.getParsedTransaction(sigInfo.signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          });
          if (!tx?.meta?.logMessages) continue;
          replayed += await this.replaySolanaLogs(sigInfo.signature, tx.meta.logMessages);
        } catch (err) {
          this.log.warn({ sig: sigInfo.signature, err }, "reconciler: Solana tx fetch failed");
        }
      }

      await this.orders.setChainCursor("solana", slot);
    } catch (err) {
      this.log.warn({ err }, "reconciler: Solana fetch failed");
    }

    return replayed;
  }

  private async replaySolanaLogs(sig: string, logs: string[]): Promise<number> {
    let eventType: string | null = null;
    const payload: Record<string, unknown> = {};

    for (const line of logs) {
      if (line.includes("OrderCreated")) eventType = "OrderCreated";
      if (line.includes("OrderClaimed")) eventType = "OrderClaimed";
      if (line.includes("OrderRefunded")) eventType = "OrderRefunded";
      const jsonMatch = line.match(/\{.*\}/);
      if (jsonMatch) {
        try { Object.assign(payload, JSON.parse(jsonMatch[0])); } catch { /* skip */ }
      }
    }

    if (!eventType) return 0;

    if (eventType === "OrderCreated") {
      const { hashlock, orderId, timelock } = payload as { hashlock?: string; orderId?: string; timelock?: number };
      if (!hashlock || !orderId) return 0;
      try {
        const order = await this.orders.findByHashlock(hashlock);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "src_lock",
          incomingSequence: null,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.srcOrderId !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "src_lock", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          if (isTerminal(order.status)) {
            reconciliationConflicts.inc({ chain: "solana", conflict_type: "chain_ahead" });
          }
          return 0;
        }
        await this.orders.recordSrcLock({ publicId: order.publicId, orderId, txHash: sig, blockNumber: 0, timelock: timelock ?? 0 });
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err, hashlock }, "reconciler: Solana OrderCreated replay error");
        return 0;
      }
    }

    if (eventType === "OrderClaimed") {
      const { preimage, orderId } = payload as { preimage?: string; orderId?: string };
      if (!preimage || !orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "secret_reveal",
          incomingSequence: null,
          existingSequence: null,
          alreadyApplied: order.preimage !== null,
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "secret_reveal", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          return 0;
        }
        if (!validatePreimage(preimage, order.hashlock)) {
          reconciliationConflicts.inc({ chain: "solana", conflict_type: "terminal_clash" });
          this.log.warn({ orderId, publicId: order.publicId }, "reconciler: Solana OrderClaimed preimage/hashlock mismatch — manual review required");
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "preimage_mismatch" });
          return 0;
        }
        await this.orders.recordSecret(order.publicId, preimage, sig);
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot record") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err }, "reconciler: Solana OrderClaimed replay error");
        return 0;
      }
    }

    if (eventType === "OrderRefunded") {
      const { orderId } = payload as { orderId?: string };
      if (!orderId) return 0;
      try {
        const order = await this.orders.findBySrcOrderId("solana", orderId);
        if (!order) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "order_not_found" });
          return 0;
        }
        const decision = decideDispatch({
          path: "replay",
          mutation: "refund",
          incomingSequence: null,
          existingSequence: order.srcLockBlock ?? null,
          alreadyApplied: order.status === "refunded" || order.status === "completed",
        });
        workflowDispatchDecisions.inc({ path: "replay", mutation: "refund", outcome: decision.reason });
        if (!decision.shouldApply) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: decision.reason });
          if (order.status === "completed") {
            reconciliationConflicts.inc({ chain: "solana", conflict_type: "terminal_clash" });
            this.log.error({ publicId: order.publicId, orderId }, "reconciler: Solana OrderRefunded conflicts with DB status=completed — manual review required");
          }
          return 0;
        }
        await this.orders.markStatus(order.publicId, "refunded");
        reconciliationRestartRecoveryEvents.inc({ chain: "solana" });
        return 1;
      } catch (err: any) {
        if (err?.message?.includes("cannot transition") || err?.message?.includes("terminal")) {
          reconciliationEventsSkipped.inc({ chain: "solana", reason: "already_applied" });
          return 0;
        }
        this.log.warn({ err }, "reconciler: Solana OrderRefunded replay error");
        return 0;
      }
    }

    return 0;
  }
}
