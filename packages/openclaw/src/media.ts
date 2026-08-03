import type {
  ContentPart,
  InboundAttachmentAvailable,
  InboundAttachmentFailed,
  InboundAttachmentReady,
  InboundMessage,
} from "@optimatist/langlangbot-connector";

type AttachmentContentPart = Extract<ContentPart, { type: "attachment" }>;

export function formatInboundBody(inbound: InboundMessage): string {
  const lines: string[] = [inbound.text.trim()];
  for (const part of inbound.parts) {
    if (part.type === "attachment") {
      lines.push(formatAttachmentPartLine(part));
    }
  }
  return lines.join("\n").trim();
}

function formatAttachmentPartLine(part: AttachmentContentPart): string {
  return (
    `[附件] ${part.filename} kind=${part.kind} status=${part.status} mime=${part.mime} size=${part.size}` +
    (part.local_path ? ` path=${part.local_path}` : "") +
    (part.download_url ? ` url=${part.download_url}` : "") +
    (part.failure_reason ? ` reason=${part.failure_reason}` : "")
  );
}

/**
 * Caption + instructions for a batch turn after every attachment is terminal.
 * Part lines (`path=` / `reason=`) are added by `formatInboundBody` from `parts`.
 */
export function formatTerminalAttachmentsText(
  caption: string,
  parts: ContentPart[],
): string {
  const attachments = parts.filter(
    (part): part is AttachmentContentPart => part.type === "attachment",
  );
  const readyCount = attachments.filter((part) => part.status === "ready").length;
  const failedCount = attachments.filter((part) => part.status === "failed").length;
  const lines: string[] = [];
  const trimmed = caption.trim();
  if (trimmed) {
    lines.push(trimmed);
  }

  if (readyCount === 0 && failedCount > 0) {
    lines.push(
      `All ${failedCount} attachment(s) failed. Explain each failure to the user; there is nothing to analyze.`,
    );
    return lines.join("\n");
  }

  if (readyCount > 0) {
    lines.push(
      failedCount > 0
        ? `${readyCount} attachment(s) ready for analysis; ${failedCount} failed.`
        : `${readyCount} attachment(s) ready for analysis.`,
    );
    lines.push(
      "Analyze every ready attachment (use image/file tools with path= or url= as needed).",
    );
  }

  if (failedCount > 0) {
    lines.push(
      "Failed attachment(s) — do not analyze these; briefly tell the user each reason.",
    );
  }

  return lines.join("\n");
}

/** True while any attachment is still uploading/processing (failed is terminal). */
export function pendingAttachmentParts(parts: ContentPart[]): boolean {
  return parts.some(
    (part) =>
      part.type === "attachment" &&
      part.status !== "ready" &&
      part.status !== "failed",
  );
}

export function attachmentAvailablePart(evt: InboundAttachmentAvailable): ContentPart {
  return {
    type: "attachment",
    upload_id: evt.uploadId,
    status: "uploading",
    kind: evt.kind,
    mime: evt.mime,
    filename: evt.filename,
    size: evt.size,
    local_path: evt.localPath,
  };
}

export function attachmentReadyPart(evt: InboundAttachmentReady): ContentPart {
  return {
    type: "attachment",
    upload_id: evt.uploadId,
    attachment_id: evt.attachmentId,
    status: "ready",
    kind: evt.kind,
    mime: evt.mime,
    filename: evt.filename,
    size: evt.size,
    download_url: evt.downloadUrl,
    local_path: evt.localPath ?? null,
  };
}

export function attachmentFailedPart(evt: InboundAttachmentFailed): ContentPart {
  return {
    type: "attachment",
    upload_id: evt.uploadId,
    status: "failed",
    kind: evt.kind,
    mime: evt.mime,
    filename: evt.filename,
    size: evt.size,
    failure_reason: evt.reason,
  };
}

export function replaceAttachmentPart(
  parts: ContentPart[],
  uploadId: string,
  replacement: ContentPart,
): ContentPart[] {
  return parts.map((part) =>
    part.type === "attachment" && part.upload_id === uploadId ? replacement : part,
  );
}
