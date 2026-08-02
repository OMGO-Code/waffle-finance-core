/**
 * Tests for the coordinator route-policy guard.
 *
 * Covers three layers:
 *  1. `checkRoutePolicy` — the pure policy function (all verdict paths).
 *  2. `announceSchema` — that the Zod schema emits structured policy issues
 *     and that address-format checks are only reached on live routes.
 *  3. Convenience helpers — `isLiveDirection`, `listLiveRoutes`,
 *     `listBlockedRoutes`.
 *
 * These tests prove the acceptance criteria from Issue #33:
 *  - The coordinator rejects invalid route and direction combinations at the
 *    policy boundary rather than later in the bridge lifecycle.
 *  - Route policy is centralized and typed.
 *  - The order pipeline no longer receives semantically invalid combinations.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  checkRoutePolicy,
  POLICY_DIRECTION_CHAINS,
  PLACEHOLDER_CHAINS,
  BLOCKED_DIRECTIONS,
  LIVE_DIRECTIONS,
  isLiveDirection,
  listLiveRoutes,
  listBlockedRoutes,
  type RoutePolicyInput,
  type RouteApproval,
  type RouteDenial,
} from "../src/validation/route-policy.js";
import {
  announceSchema,
  DIRECTION_CHAINS,
} from "../src/validation/announce.js";
import type { Direction } from "../src/persistence/orders-repo.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_HASHLOCK = "0x" + "ab".repeat(32);

const ADDR = {
  ethereum: "0x1111111111111111111111111111111111111111",
  stellar: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  solana: "11111111111111111111111111111111",
} as const;

function validAnnounce(direction: Direction) {
  const { src, dst } = POLICY_DIRECTION_CHAINS[direction];
  return {
    direction,
    hashlock: VALID_HASHLOCK,
    srcChain: src,
    srcAddress: ADDR[src],
    srcAsset: "native",
    srcAmount: "1000000000000000000",
    srcSafetyDeposit: "1000000000000000",
    dstChain: dst,
    dstAddress: ADDR[dst],
    dstAsset: "native",
    dstAmount: "100000000",
  };
}

// ── checkRoutePolicy: approval paths ─────────────────────────────────────────

describe("checkRoutePolicy — approvals", () => {
  it("approves every currently live direction with correct chains", () => {
    for (const direction of LIVE_DIRECTIONS) {
      const { src, dst } = POLICY_DIRECTION_CHAINS[direction];
      const verdict = checkRoutePolicy({ direction, srcChain: src, dstChain: dst });
      expect(verdict.allowed).toBe(true);
      if (verdict.allowed) {
        expect((verdict as RouteApproval).srcChain).toBe(src);
        expect((verdict as RouteApproval).dstChain).toBe(dst);
      }
    }
  });

  it("returns the canonical chain values on approval regardless of input casing context", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "ethereum",
      dstChain: "stellar",
    });
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect((verdict as RouteApproval).srcChain).toBe("ethereum");
      expect((verdict as RouteApproval).dstChain).toBe("stellar");
    }
  });

  it("approves xlm_to_eth with the correct chains", () => {
    const verdict = checkRoutePolicy({
      direction: "xlm_to_eth",
      srcChain: "stellar",
      dstChain: "ethereum",
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ── checkRoutePolicy: DIRECTION_UNSUPPORTED ───────────────────────────────────

describe("checkRoutePolicy — DIRECTION_UNSUPPORTED", () => {
  it("rejects an empty direction string", () => {
    const verdict = checkRoutePolicy({ direction: "", srcChain: "ethereum", dstChain: "stellar" });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("DIRECTION_UNSUPPORTED");
  });

  it("rejects a completely unknown direction slug", () => {
    const verdict = checkRoutePolicy({ direction: "btc_to_eth", srcChain: "ethereum", dstChain: "ethereum" });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("DIRECTION_UNSUPPORTED");
    expect((verdict as RouteDenial).field).toBe("direction");
  });

  it("rejects a hyphenated variant that the API does not accept", () => {
    const verdict = checkRoutePolicy({ direction: "eth-to-xlm", srcChain: "ethereum", dstChain: "stellar" });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("DIRECTION_UNSUPPORTED");
  });

  it("includes the live directions in the denial reason so operators can self-correct", () => {
    const verdict = checkRoutePolicy({ direction: "nope", srcChain: "ethereum", dstChain: "stellar" });
    expect(verdict.allowed).toBe(false);
    const reason = (verdict as RouteDenial).reason;
    for (const live of LIVE_DIRECTIONS) {
      expect(reason).toContain(live);
    }
  });
});

// ── checkRoutePolicy: DIRECTION_BLOCKED ──────────────────────────────────────

describe("checkRoutePolicy — DIRECTION_BLOCKED", () => {
  it("allows eth_to_sol now that Solana is live", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_sol",
      srcChain: "ethereum",
      dstChain: "solana",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("allows sol_to_eth now that Solana is live", () => {
    const verdict = checkRoutePolicy({
      direction: "sol_to_eth",
      srcChain: "solana",
      dstChain: "ethereum",
    });
    expect(verdict.allowed).toBe(true);
  });

  it("every direction that touches a placeholder chain is blocked", () => {
    // Derive the set of blocked directions from the placeholder chains table
    // and verify each one is actually rejected by the policy.
    for (const [direction, { src, dst }] of Object.entries(POLICY_DIRECTION_CHAINS) as [
      Direction,
      { src: string; dst: string },
    ][]) {
      if (src in PLACEHOLDER_CHAINS || dst in PLACEHOLDER_CHAINS) {
        const verdict = checkRoutePolicy({ direction, srcChain: src, dstChain: dst });
        expect(verdict.allowed).toBe(false);
        expect((verdict as RouteDenial).code).toBe("DIRECTION_BLOCKED");
      }
    }
  });
});

// ── checkRoutePolicy: SAME_CHAIN_ROUTE ───────────────────────────────────────

describe("checkRoutePolicy — SAME_CHAIN_ROUTE", () => {
  it("rejects a request where srcChain and dstChain are the same", () => {
    // Use a known live direction but force both legs onto the same chain —
    // this is structurally nonsensical and should be caught before chain-
    // alignment checking.
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "ethereum",
      dstChain: "ethereum",
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("SAME_CHAIN_ROUTE");
    expect((verdict as RouteDenial).field).toBe("dstChain");
  });

  it("rejection message names the offending chain", () => {
    const verdict = checkRoutePolicy({
      direction: "xlm_to_eth",
      srcChain: "stellar",
      dstChain: "stellar",
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).reason).toContain("stellar");
  });
});

// ── checkRoutePolicy: CHAIN_MISMATCH ─────────────────────────────────────────

describe("checkRoutePolicy — CHAIN_MISMATCH", () => {
  it("rejects eth_to_xlm when srcChain is solana", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "solana",
      dstChain: "stellar",
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("CHAIN_MISMATCH");
    expect((verdict as RouteDenial).field).toBe("srcChain");
  });

  it("rejects eth_to_xlm when dstChain is solana", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "ethereum",
      dstChain: "solana",
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("CHAIN_MISMATCH");
    expect((verdict as RouteDenial).field).toBe("dstChain");
  });

  it("rejects xlm_to_eth when srcChain is ethereum (direction/chain inversion)", () => {
    const verdict = checkRoutePolicy({
      direction: "xlm_to_eth",
      srcChain: "ethereum",
      dstChain: "stellar",
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("CHAIN_MISMATCH");
  });

  it("rejection message names both the required and declared chain", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "solana",
      dstChain: "stellar",
    });
    expect(verdict.allowed).toBe(false);
    const reason = (verdict as RouteDenial).reason;
    expect(reason).toContain("ethereum");   // required
    expect(reason).toContain("solana");      // declared
  });

  it("rejects every direction when paired with the wrong chains", () => {
    const directions = Object.keys(POLICY_DIRECTION_CHAINS) as Direction[];
    for (const direction of directions) {
      // Find a different direction whose chain mapping is distinct
      const wrongDirection = directions.find(
        (d) =>
          d !== direction &&
          (POLICY_DIRECTION_CHAINS[d].src !== POLICY_DIRECTION_CHAINS[direction].src ||
            POLICY_DIRECTION_CHAINS[d].dst !== POLICY_DIRECTION_CHAINS[direction].dst)
      );
      if (!wrongDirection) continue;
      const { src, dst } = POLICY_DIRECTION_CHAINS[wrongDirection];
      const verdict = checkRoutePolicy({ direction, srcChain: src, dstChain: dst });
      // May be DIRECTION_BLOCKED for Solana directions, or CHAIN_MISMATCH for live ones
      expect(verdict.allowed).toBe(false);
    }
  });
});

// ── Denial ordering: blocked before mismatch ─────────────────────────────────

describe("checkRoutePolicy — denial ordering", () => {
  it("CHAIN_MISMATCH is returned when chains are wrong for a live direction", () => {
    // eth_to_sol with wrong chains — CHAIN_MISMATCH should be returned.
    const verdict = checkRoutePolicy({
      direction: "eth_to_sol",
      srcChain: "stellar",   // also wrong
      dstChain: "ethereum",  // also wrong
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("CHAIN_MISMATCH");
  });

  it("SAME_CHAIN_ROUTE is returned before CHAIN_MISMATCH for a same-chain live direction", () => {
    const verdict = checkRoutePolicy({
      direction: "eth_to_xlm",
      srcChain: "ethereum",
      dstChain: "ethereum",  // same-chain AND wrong for the dst leg
    });
    expect(verdict.allowed).toBe(false);
    expect((verdict as RouteDenial).code).toBe("SAME_CHAIN_ROUTE");
  });
});

// ── announceSchema integration ────────────────────────────────────────────────

describe("announceSchema — route-policy integration", () => {
  it("accepts all live directions with valid payloads", () => {
    for (const direction of LIVE_DIRECTIONS) {
      const result = announceSchema.safeParse(validAnnounce(direction));
      expect(result.success, `direction ${direction} should be accepted`).toBe(true);
    }
  });

  it("accepts eth_to_sol as a live direction", () => {
    const result = announceSchema.safeParse(validAnnounce("eth_to_sol"));
    expect(result.success).toBe(true);
  });

  it("accepts sol_to_eth as a live direction", () => {
    const result = announceSchema.safeParse(validAnnounce("sol_to_eth"));
    expect(result.success).toBe(true);
  });

  it("emits exactly one issue on a mismatched direction (no cascading errors)", () => {

  it("rejects a mismatched srcChain with CHAIN_MISMATCH before running address checks", () => {
    const payload = {
      ...validAnnounce("eth_to_xlm"),
      srcChain: "solana",
      srcAddress: ADDR.solana,
    };
    const result = announceSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toContain("srcChain");
      expect((issue.params as any)?.routePolicyCode).toBe("CHAIN_MISMATCH");
    }
  });

  it("still runs address validation for live routes with bad addresses", () => {
    const result = announceSchema.safeParse({
      ...validAnnounce("eth_to_xlm"),
      srcAddress: "not-an-eth-address",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Policy passes (live route, correct chains) — address check runs
      const addressIssue = result.error.issues.find((i) => i.path[0] === "srcAddress");
      expect(addressIssue).toBeDefined();
      // No routePolicyCode — this is an address-format error, not a policy denial
      expect((addressIssue!.params as any)?.routePolicyCode).toBeUndefined();
    }
  });

  it("produces a ZodError (not a thrown exception) for policy denials", () => {
    expect(() => announceSchema.parse(validAnnounce("eth_to_sol"))).toThrow(z.ZodError);
  });
});

// ── DIRECTION_CHAINS backward-compat re-export ────────────────────────────────

describe("DIRECTION_CHAINS backward-compat re-export", () => {
  it("DIRECTION_CHAINS contains the same data as POLICY_DIRECTION_CHAINS", () => {
    expect(DIRECTION_CHAINS).toStrictEqual(POLICY_DIRECTION_CHAINS);
  });

  it("includes all four directions (including blocked ones) for legacy consumers", () => {
    expect(Object.keys(DIRECTION_CHAINS).sort()).toEqual(
      ["eth_to_sol", "eth_to_xlm", "sol_to_eth", "xlm_to_eth"]
    );
  });
});

// ── Convenience helpers ───────────────────────────────────────────────────────

describe("isLiveDirection", () => {
  it("returns true for live directions", () => {
    for (const d of LIVE_DIRECTIONS) {
      expect(isLiveDirection(d)).toBe(true);
    }
  });

  it("returns true for all declared directions including Solana", () => {
    expect(isLiveDirection("eth_to_sol")).toBe(true);
    expect(isLiveDirection("sol_to_eth")).toBe(true);
  });

  it("returns false for unknown strings", () => {
    expect(isLiveDirection("btc_to_eth")).toBe(false);
    expect(isLiveDirection("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isLiveDirection(null)).toBe(false);
    expect(isLiveDirection(42)).toBe(false);
    expect(isLiveDirection(undefined)).toBe(false);
    expect(isLiveDirection({})).toBe(false);
  });
});

describe("listLiveRoutes", () => {
  it("only returns directions that are not blocked", () => {
    const live = listLiveRoutes();
    for (const { direction } of live) {
      expect(BLOCKED_DIRECTIONS.has(direction)).toBe(false);
    }
  });

  it("each route has consistent src/dst from the policy table", () => {
    for (const { direction, srcChain, dstChain } of listLiveRoutes()) {
      expect(POLICY_DIRECTION_CHAINS[direction].src).toBe(srcChain);
      expect(POLICY_DIRECTION_CHAINS[direction].dst).toBe(dstChain);
    }
  });

  it("includes eth_to_xlm, xlm_to_eth, eth_to_sol, and sol_to_eth", () => {
    const ids = listLiveRoutes().map((r) => r.direction);
    expect(ids).toContain("eth_to_xlm");
    expect(ids).toContain("xlm_to_eth");
    expect(ids).toContain("eth_to_sol");
    expect(ids).toContain("sol_to_eth");
  });
});

describe("listBlockedRoutes", () => {
  it("returns an empty list when no chains are placeholders", () => {
    const blocked = listBlockedRoutes();
    expect(blocked).toEqual([]);
  });
});

describe("BLOCKED_DIRECTIONS and PLACEHOLDER_CHAINS consistency", () => {
  it("every direction in BLOCKED_DIRECTIONS touches a chain in PLACEHOLDER_CHAINS", () => {
    for (const direction of BLOCKED_DIRECTIONS.keys()) {
      const { src, dst } = POLICY_DIRECTION_CHAINS[direction];
      const touches = src in PLACEHOLDER_CHAINS || dst in PLACEHOLDER_CHAINS;
      expect(touches).toBe(true);
    }
  });

  it("no live direction touches a placeholder chain", () => {
    for (const direction of LIVE_DIRECTIONS) {
      const { src, dst } = POLICY_DIRECTION_CHAINS[direction];
      expect(src in PLACEHOLDER_CHAINS).toBe(false);
      expect(dst in PLACEHOLDER_CHAINS).toBe(false);
    }
  });

  it("all directions are live when PLACEHOLDER_CHAINS is empty", () => {
    expect(Object.keys(PLACEHOLDER_CHAINS)).toHaveLength(0);
    expect(LIVE_DIRECTIONS).toHaveLength(Object.keys(POLICY_DIRECTION_CHAINS).length);
  });
});
