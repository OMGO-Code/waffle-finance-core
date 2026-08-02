import type { FeatureFlags } from "@wafflefinance/config";

/**
 * Runtime feature flag utilities shared across WaffleFinance services.
 *
 * Use these helpers instead of reading env vars directly so gating logic
 * stays consistent between build-time (Vite define) and runtime (parsed config).
 */

export function isFeatureEnabled(flags: FeatureFlags | undefined, name: keyof FeatureFlags): boolean {
  return flags?.[name] ?? false;
}

export function requireFeature(flags: FeatureFlags | undefined, name: keyof FeatureFlags): void {
  if (!isFeatureEnabled(flags, name)) {
    throw new Error(
      `Feature flag "${String(name)}" is disabled. ` +
        `Enable it in your environment to use this experimental flow.`
    );
  }
}

export const FEATURE_FLAG_DESCRIPTIONS: Record<keyof FeatureFlags, { description: string; defaultEnv: string }> = {
  solanaSimulationMode: {
    description: "When enabled, forces Solana into simulation/mock mode even when a real program ID is configured. Used for testing.",
    defaultEnv: "false",
  },
  sorobanEarlySupport: {
    description: "Enables early Soroban chain support (experimental routes and contract bindings).",
    defaultEnv: "false",
  },
  experimentalUiRoutes: {
    description: "Enables experimental UI routes and features not yet ready for production users.",
    defaultEnv: "false",
  },
};
