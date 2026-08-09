const CHANNEL = "langlangbot";

function openClawFromForOwnerSurface(surfaceId: string): string {
  const trimmed = surfaceId.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("owner:") ? trimmed : `owner:${trimmed}`;
}

/** OpenClaw command-owner allow entry for a verified owner surface. */
export function openClawOwnerAllowFrom(surfaceId: string): string {
  const from = openClawFromForOwnerSurface(surfaceId);
  if (!from) {
    return "";
  }
  if (from.toLowerCase().startsWith(`${CHANNEL}:`)) {
    return from;
  }
  return `${CHANNEL}:${from}`;
}

export function resolveVerifiedOwnerSurface(params: {
  ownerSurfaceId?: string | null;
}): string | null {
  const verified = params.ownerSurfaceId?.trim();
  return verified || null;
}

export function resolveOwnerFrom(params: {
  ownerSurfaceId?: string | null;
  conversationId: string;
}): string {
  const surfaceId = resolveVerifiedOwnerSurface({
    ownerSurfaceId: params.ownerSurfaceId,
  });
  if (surfaceId) {
    return openClawFromForOwnerSurface(surfaceId);
  }
  return `owner:${params.conversationId}`;
}
