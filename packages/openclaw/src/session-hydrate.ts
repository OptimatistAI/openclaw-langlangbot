import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Refill an empty OpenClaw session from the sidecar transcript.
 *
 * OpenClaw mints a new session file when its store misses the conversation
 * key (gateway restart, state-dir switch). The Operator transcript still
 * lives in the sidecar event log. On the first turn into that empty session
 * we prepend the prior turns to the user text that OpenClaw stores
 * (`CommandBody`), so later turns in the same session keep the restored
 * context.
 */

export type TranscriptTurn = {
  role?: string;
  message_id?: string | null;
  text?: string;
  created_at?: string;
};

export const SESSION_HISTORY_BEGIN = "[langlangbot-session-history]";
export const SESSION_HISTORY_END = "[/langlangbot-session-history]";

/** Silent empty-session seed: last 30 minutes, not the full Operator archive. */
export const AUTO_HISTORY_MAX_AGE_MS = 30 * 60 * 1000;
export const AUTO_HISTORY_MESSAGE_LIMIT = 20;
export const AUTO_HISTORY_CHAR_BUDGET = 8_000;
/** Rough per-turn label overhead for `"User: "` / `"Assistant: "` + blank line. */
const HISTORY_TURN_OVERHEAD = 12;

function lineHasConversationTurn(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const row = JSON.parse(trimmed) as { type?: string; message?: { role?: string } };
    const role = row.message?.role;
    return row.type === "message" && (role === "user" || role === "assistant");
  } catch {
    return false;
  }
}

export function transcriptHasConversationTurns(jsonl: string): boolean {
  let start = 0;
  while (start <= jsonl.length) {
    const end = jsonl.indexOf("\n", start);
    const lineEnd = end === -1 ? jsonl.length : end;
    if (lineHasConversationTurn(jsonl.slice(start, lineEnd))) {
      return true;
    }
    if (end === -1) {
      break;
    }
    start = lineEnd + 1;
  }
  return false;
}

/**
 * True when the session file is missing or has no user/assistant turn yet.
 * Stops at the first such turn so a long transcript is not read in full.
 */
export function sessionFileNeedsRestore(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let settled = false;
    const finish = (needsRestore: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      lines.close();
      stream.destroy();
      resolve(needsRestore);
    };
    const fail = (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      if (err.code === "ENOENT") {
        finish(true);
        return;
      }
      settled = true;
      lines.close();
      stream.destroy();
      reject(err);
    };
    stream.on("error", fail);
    lines.on("error", fail);
    lines.on("line", (line) => {
      if (lineHasConversationTurn(line)) {
        finish(false);
      }
    });
    lines.on("close", () => finish(true));
  });
}

/** `null` means the session file is missing. A header-only file still needs restore. */
export function sessionTranscriptNeedsRestore(transcriptJsonl: string | null): boolean {
  if (transcriptJsonl == null) {
    return true;
  }
  return !transcriptHasConversationTurns(transcriptJsonl);
}

/**
 * Build the hydrated inbound text for an already-empty OpenClaw session.
 * Callers must skip slash commands and non-empty session files first.
 */
export function planSessionHistoryRestore(params: {
  turns: TranscriptTurn[];
  currentMessageId: string;
  currentText: string;
}): { text: string; restoredTurns: number } {
  const selected = selectHistoryTurns({
    turns: params.turns,
    currentMessageId: params.currentMessageId,
    currentText: params.currentText,
    messageLimit: AUTO_HISTORY_MESSAGE_LIMIT,
    charBudget: AUTO_HISTORY_CHAR_BUDGET,
  });
  const history = renderSessionHistory(selected);
  if (!history) {
    return { text: params.currentText, restoredTurns: 0 };
  }
  return {
    text: `${history}\n\n${params.currentText}`,
    restoredTurns: selected.length,
  };
}

export function selectHistoryTurns(params: {
  turns: TranscriptTurn[];
  currentMessageId: string;
  currentText: string;
  messageLimit?: number;
  charBudget?: number;
}): TranscriptTurn[] {
  const messageLimit = params.messageLimit ?? AUTO_HISTORY_MESSAGE_LIMIT;
  const charBudget = params.charBudget ?? AUTO_HISTORY_CHAR_BUDGET;
  const eligible = priorTurnsOnly(
    params.turns,
    params.currentMessageId,
    params.currentText,
  )
    .filter((turn) => {
      const role = turn.role;
      return (role === "user" || role === "assistant") && (turn.text ?? "").trim().length > 0;
    })
    .slice(-messageLimit);

  const selected: TranscriptTurn[] = [];
  let used = 0;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    let text = (eligible[index]?.text ?? "").trim();
    if (selected.length > 0 && used + text.length + HISTORY_TURN_OVERHEAD > charBudget) {
      break;
    }
    if (used + text.length + HISTORY_TURN_OVERHEAD > charBudget) {
      const room = charBudget - used - HISTORY_TURN_OVERHEAD;
      if (room <= 0) {
        break;
      }
      text = text.slice(text.length - room);
    }
    selected.push({ ...eligible[index], text });
    used += text.length + HISTORY_TURN_OVERHEAD;
    if (used >= charBudget) {
      break;
    }
  }
  selected.reverse();
  return selected;
}

export function renderSessionHistory(turns: TranscriptTurn[]): string {
  if (turns.length === 0) {
    return "";
  }
  const lines = [
    SESSION_HISTORY_BEGIN,
    "The OpenClaw session for this conversation was empty. The turns below are restored from the LangLangBot transcript for this same conversation. Continue from them. Do not tell the user that the session was restored.",
    "",
  ];
  for (const turn of turns) {
    const label = turn.role === "assistant" ? "Assistant" : "User";
    lines.push(`${label}: ${(turn.text ?? "").trim()}`);
    lines.push("");
  }
  lines.push(SESSION_HISTORY_END);
  return lines.join("\n");
}

/**
 * Keep only turns strictly before the in-flight message.
 * Filtering by id alone would leave newer sidecar turns (posted while this
 * inbound is still hydrating) in the synthetic history block.
 */
function priorTurnsOnly(
  turns: TranscriptTurn[],
  currentMessageId: string,
  currentText: string,
): TranscriptTurn[] {
  const id = currentMessageId.trim().toLowerCase();
  if (id) {
    const index = turns.findIndex(
      (turn) => (turn.message_id ?? "").trim().toLowerCase() === id,
    );
    if (index >= 0) {
      return turns.slice(0, index);
    }
  }
  const last = turns.at(-1);
  if (last?.role === "user" && (last.text ?? "").trim() === currentText.trim()) {
    return turns.slice(0, -1);
  }
  return turns;
}
