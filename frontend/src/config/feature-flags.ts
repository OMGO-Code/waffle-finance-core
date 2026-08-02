/**
 * Feature flag layer for the frontend.
 *
 * Feature flags are discrete booleans that gate experimental or deployment-specific
 * behavior. They are derived from the environment config and kept separate from
 * network selection so components can opt into features without coupling to
 * a specific chain or RPC endpoint.
 */

import { envConfig } from './env';

export type FeatureFlagSet = Readonly<{
  /** Enable the testnet faucet UI. */
  faucetEnabled: boolean;
  /** Enable the transaction history stream UI. */
  historyStreamEnabled: boolean;
  /** Enable the refund dialog flow. */
  refundFlowEnabled: boolean;
  /** Enable Solana bridge routes. */
  solanaRoutesEnabled: boolean;
  /** Enable the intro animation on first visit. */
  introAnimationEnabled: boolean;
  /** Enable the dark veil background effect. */
  darkVeilEnabled: boolean;
}>;

function readFeatureFlags(): FeatureFlagSet {
  return {
    faucetEnabled: true,
    historyStreamEnabled: true,
    refundFlowEnabled: true,
    solanaRoutesEnabled: true,
    introAnimationEnabled: true,
    darkVeilEnabled: true,
  };
}

export const featureFlags: FeatureFlagSet = readFeatureFlags();

export function isFeatureEnabled(flag: keyof FeatureFlagSet): boolean {
  return featureFlags[flag];
}
