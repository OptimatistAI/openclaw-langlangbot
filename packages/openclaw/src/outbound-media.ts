import type {
  AttachmentKind,
  ContentPart,
} from "@optimatist/langlangbot-connector";

import type { LanglangbotSidecar } from "@optimatist/langlangbot-connector";


export async function sendPendingOutboundFile(
  sidecar: LanglangbotSidecar,
  conversationId: string,
  accountId: string,
  localPath: string,
  filename: string,
  mime?: string,
  statusText?: string,
): Promise<{ attachmentId: string; uploadId: string }> {
  const pending = await sidecar.registerOutboundAttachment(
    conversationId,
    {
      localPath,
      filename,
      mime,
      status: "processing",
    },
    accountId,
  );
  const parts: ContentPart[] = [
    {
      type: "attachment",
      upload_id: pending.upload_id,
      attachment_id: pending.attachment_id,
      status: "processing",
      kind: guessKind(filename, mime),
      mime: mime ?? "application/octet-stream",
      filename,
      size: 0,
      download_url: pending.download_url,
      local_path: localPath,
    },
  ];
  await sidecar.sendMessage(
    conversationId,
    statusText ?? `Sending ${filename}...`,
    undefined,
    parts,
  );
  await sidecar.markOutboundAttachmentReady(conversationId, pending.attachment_id);
  return {
    attachmentId: pending.attachment_id,
    uploadId: pending.upload_id,
  };
}

function guessKind(filename: string, mime?: string): AttachmentKind {
  const lower = (mime ?? filename).toLowerCase();
  if (lower.includes("image/") || /\.(png|jpe?g|gif|webp|bmp)$/.test(lower)) {
    return "image";
  }
  if (lower.includes("audio/") || /\.(mp3|wav|ogg|aac|flac|m4a)$/.test(lower)) {
    return "audio";
  }
  if (lower.includes("video/") || /\.(mp4|mov|avi|mkv|webm)$/.test(lower)) {
    return "video";
  }
  return "file";
}
