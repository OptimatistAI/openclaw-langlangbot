/**
 * Pairing-based runtime exclusivity (sidecar Step 1.5).
 *
 * Until multi-agent routing exists, the runtime kind the sidecar was paired
 * with solely owns inbound subscription / claim / status. An openclaw channel
 * on a sidecar paired with another runtime stays idle instead of stealing the
 * stream. When the sidecar reports no paired kind (legacy/dev installs) the
 * openclaw channel behaves exactly as before.
 */

/** This plugin's runtime kind; matches AGENT_RUNTIME_KIND in runtime-identity. */
export const OWN_RUNTIME_KIND = "openclaw";

export type SidecarPairingDecision =
  | { engage: true }
  | { engage: false; reason: string };

/** Pure decision: should this runtime engage the sidecar's inbound surfaces? */
export function shouldEngageSidecar(
  pairedRuntimeKind: string | null | undefined,
  ownKind: string = OWN_RUNTIME_KIND,
): SidecarPairingDecision {
  const paired = pairedRuntimeKind?.trim();
  if (!paired) {
    // Unpaired (or pre-1.5 sidecar without the /health field): legacy path.
    return { engage: true };
  }
  if (paired.toLowerCase() === ownKind.toLowerCase()) {
    return { engage: true };
  }
  return {
    engage: false,
    reason: `LangLangBot sidecar is paired with ${paired}; the openclaw channel stays idle (re-pair with --runtime ${OWN_RUNTIME_KIND} to use it)`,
  };
}
