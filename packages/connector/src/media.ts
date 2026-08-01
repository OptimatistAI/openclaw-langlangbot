export type AttachmentKind = "image" | "audio" | "video" | "file";

export type AttachmentStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "ready"
  | "failed";

export type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "attachment";
      upload_id?: string | null;
      attachment_id?: string | null;
      status: AttachmentStatus;
      kind: AttachmentKind;
      mime: string;
      filename: string;
      size: number;
      download_url?: string | null;
      local_path?: string | null;
      failure_reason?: string | null;
    };

export type InboundAttachmentReady = {
  conversationId: string;
  messageId?: string;
  uploadId: string;
  attachmentId: string;
  filename: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  downloadUrl: string;
  localPath?: string;
  readyAt: string;
  /** SSE `id:`; pass to `ackInbound`. */
  seq?: string;
};

export type InboundAttachmentAvailable = {
  conversationId: string;
  messageId?: string;
  uploadId: string;
  filename: string;
  mime: string;
  kind: AttachmentKind;
  bytesAvailable: number;
  size: number;
  localPath: string;
  streamable: boolean;
  final: boolean;
  updatedAt: string;
  /** SSE `id:`; pass to `ackInbound`. */
  seq?: string;
};

export type InboundAttachmentFailed = {
  conversationId: string;
  messageId?: string;
  uploadId: string;
  filename: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  reason: string;
  failedAt: string;
  /** SSE `id:`; pass to `ackInbound`. */
  seq?: string;
};

export type RegisterOutboundAttachmentInput = {
  localPath: string;
  filename: string;
  mime?: string;
  size?: number;
  sha256?: string;
  status?: AttachmentStatus;
};

export type RegisterOutboundAttachmentResult = {
  attachment_id: string;
  upload_id: string;
  status: AttachmentStatus;
  download_url: string;
};

export function textFromParts(parts: ContentPart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[attachment ${part.filename} (${part.status})]`;
    })
    .join("\n")
    .trim();
}

export function parseContentParts(raw: unknown): ContentPart[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const parts: ContentPart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "attachment") {
      parts.push({
        type: "attachment",
        upload_id:
          part.upload_id == null ? null : String(part.upload_id),
        attachment_id:
          part.attachment_id == null ? null : String(part.attachment_id),
        status: String(part.status ?? "pending") as AttachmentStatus,
        kind: String(part.kind ?? "file") as AttachmentKind,
        mime: String(part.mime ?? "application/octet-stream"),
        filename: String(part.filename ?? "attachment"),
        size: Number(part.size ?? 0),
        download_url:
          part.download_url == null ? null : String(part.download_url),
        local_path:
          part.local_path == null ? null : String(part.local_path),
        failure_reason:
          part.failure_reason == null
            ? null
            : String(part.failure_reason),
      });
    }
  }
  return parts;
}
