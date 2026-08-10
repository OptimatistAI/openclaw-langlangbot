import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import type { ContentPart } from "@optimatist/langlangbot-connector";

import type { LanglangbotSidecar } from "@optimatist/langlangbot-connector";

/** Mirrors MediaStorageConfig::from_env on the sidecar. */
function mediaRoot(): string {
  const fromEnv = process.env.LANGLANGBOT_MEDIA_ROOT?.trim();
  return fromEnv
    ? resolve(fromEnv)
    : join(homedir(), ".openclaw", "media", "langlangbot");
}

function isWithinMediaRoot(path: string): boolean {
  const root = mediaRoot();
  return path === root || path.startsWith(`${root}${sep}`);
}

/** Mirrors OpenClaw's resolveConfigDir. */
function openclawStateDir(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return resolve(stateDir);
  }
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return dirname(resolve(configPath));
  }
  return join(homedir(), ".openclaw");
}

/**
 * Where the agent should write files it intends to send.
 *
 * OpenClaw treats `<state>/media/tool-*` as managed media and hands such paths
 * to the channel untouched; anywhere else it first persists its own copy. So
 * exporting here keeps one copy on the OpenClaw side instead of two.
 */
export function outboundExportDir(): string {
  return join(openclawStateDir(), "media", "tool-langlangbot");
}

const STAGED_NAME_RE =
  /^(.+)---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)?$/i;

/**
 * OpenClaw stages reply media as `<name>---<uuid><ext>`; show the original name.
 */
function displayFilename(filename: string): string {
  const match = STAGED_NAME_RE.exec(filename);
  return match ? `${match[1]}${match[2] ?? ""}` : filename;
}

/** The name the user sees, and the only name the sidecar is told about. */
function visibleNameFor(localPath: string): string {
  return displayFilename(basename(localPath)) || "attachment.bin";
}

/**
 * The sidecar only accepts local paths inside its media root, but OpenClaw
 * stages reply media into its own state dir. Bridge those in first.
 * Returns the path to register plus a cleanup callback.
 */
async function stageIntoMediaRoot(
  localPath: string,
  filename: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const resolved = resolve(localPath);
  if (isWithinMediaRoot(resolved)) {
    return { path: resolved, cleanup: async () => {} };
  }
  // Per-copy directory keeps the visible filename clean without collisions.
  const dir = join(mediaRoot(), "outbound", randomUUID());
  await mkdir(dir, { recursive: true });
  const staged = join(dir, filename);
  // Registration copies the bytes again into the sidecar's own tree, so this
  // hop only needs to expose the file at an acceptable path. A link does that
  // without a second pass over a possibly large video; both trees normally sit
  // under $HOME, and the fallback covers the case where they do not.
  try {
    await link(resolved, staged);
  } catch {
    await copyFile(resolved, staged);
  }
  return {
    path: staged,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export interface StagedOutboundFile {
  attachmentId: string;
  uploadId: string;
  /** Name shown to the user, with OpenClaw's staging suffix stripped. */
  filename: string;
  part: ContentPart;
}

/**
 * Import one file into the sidecar's media store. No message is sent, so
 * callers can put several attachments in a single message.
 */
async function stageOutboundFile(
  sidecar: LanglangbotSidecar,
  conversationId: string,
  accountId: string,
  localPath: string,
): Promise<StagedOutboundFile> {
  const visibleName = visibleNameFor(localPath);
  const staged = await stageIntoMediaRoot(localPath, visibleName);

  let registered;
  try {
    // register_outbound_from_path copies, hashes, size-checks and sniffs the
    // content before it returns, so there is nothing left to wait for: the
    // attachment is downloadable and `ready` is the truthful status. Sending
    // `processing` here would need a second round-trip to undo, and strands
    // the bubble if that round-trip never lands.
    //
    // No `mime`: the sidecar runs mime_guess over the real path and derives
    // `kind` from it. Anything we guessed here could only be worse.
    registered = await sidecar.registerOutboundAttachment(
      conversationId,
      { localPath: staged.path, filename: visibleName, status: "ready" },
      accountId,
    );
  } finally {
    await staged.cleanup().catch(() => undefined);
  }

  return {
    attachmentId: registered.attachment_id,
    uploadId: registered.upload_id,
    filename: visibleName,
    part: {
      type: "attachment",
      upload_id: registered.upload_id,
      attachment_id: registered.attachment_id,
      status: registered.status,
      kind: registered.kind,
      mime: registered.mime,
      filename: visibleName,
      size: registered.size,
      // No local_path: the staging copy is gone and the sidecar's imported
      // copy lives under its own root. Clients fetch via download_url.
      download_url: registered.download_url,
    },
  };
}

/**
 * A caption that is just a filename adds nothing — the name already travels in
 * `parts[].filename`, and clients render it on the attachment card. Kept as an
 * exact match rather than a "does this look like a filename" heuristic: the
 * plugin never invents such a caption, so this only catches a caller passing
 * the name through.
 */
function resolveCaption(
  caption: string | undefined,
  localPaths: string[],
): string {
  const text = (caption ?? "").trim();
  if (!text) {
    return "";
  }
  const names = new Set<string>();
  for (const path of localPaths) {
    names.add(path);
    names.add(basename(path));
    names.add(visibleNameFor(path));
  }
  return names.has(text) ? "" : text;
}

/**
 * Deliver files as one message: the agent's own explanation (if any) plus every
 * attachment. One bubble, so the media card is never orphaned from its context.
 */
export async function sendOutboundFiles(
  sidecar: LanglangbotSidecar,
  conversationId: string,
  accountId: string,
  localPaths: string[],
  caption?: string,
): Promise<{ messageId: string; files: StagedOutboundFile[] }> {
  const staged: StagedOutboundFile[] = [];
  for (const localPath of localPaths) {
    staged.push(
      await stageOutboundFile(sidecar, conversationId, accountId, localPath),
    );
  }
  const sent = await sidecar.sendMessage(
    conversationId,
    resolveCaption(caption, localPaths),
    undefined,
    staged.map((file) => file.part),
  );
  return { messageId: sent.message_id, files: staged };
}
