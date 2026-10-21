import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AUTO_HISTORY_CHAR_BUDGET,
  SESSION_HISTORY_BEGIN,
  SESSION_HISTORY_END,
  planSessionHistoryRestore,
  selectHistoryTurns,
  sessionFileNeedsRestore,
  sessionTranscriptNeedsRestore,
  transcriptHasConversationTurns,
} from "./session-hydrate.ts";

const headerOnly = [
  JSON.stringify({ type: "session", version: 3, id: "abc" }),
  JSON.stringify({ type: "model_change", id: "m1", parentId: null }),
].join("\n");

test("header-only transcripts need restore and conversation turns do not", () => {
  assert.equal(transcriptHasConversationTurns(headerOnly), false);
  assert.equal(sessionTranscriptNeedsRestore(null), true);
  assert.equal(sessionTranscriptNeedsRestore(headerOnly), true);
  const withTurn = `${headerOnly}\n${JSON.stringify({
    type: "message",
    id: "u1",
    message: { role: "user", content: "hello" },
  })}`;
  assert.equal(transcriptHasConversationTurns(withTurn), true);
  assert.equal(sessionTranscriptNeedsRestore(withTurn), false);
  assert.equal(transcriptHasConversationTurns("{not json}\n"), false);
});

test("session file restore stops at the first conversation turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "langlangbot-session-"));
  const path = join(dir, "session.jsonl");
  const turn = JSON.stringify({
    type: "message",
    id: "u1",
    message: { role: "user", content: "hello" },
  });
  await writeFile(path, `${headerOnly}\n${turn}\n${"x".repeat(200_000)}\n`);
  assert.equal(await sessionFileNeedsRestore(path), false);
  assert.equal(await sessionFileNeedsRestore(join(dir, "missing.jsonl")), true);
});

test("selectHistoryTurns drops the in-flight message and keeps oldest-first order", () => {
  const turns = selectHistoryTurns({
    turns: [
      { role: "user", message_id: "u1", text: "earlier" },
      { role: "assistant", message_id: "a1", text: "answer" },
      { role: "user", message_id: "u2", text: "what were we talking about?" },
      { role: "tool", message_id: "t1", text: "ignored" },
    ],
    currentMessageId: "U2",
    currentText: "what were we talking about?",
    messageLimit: 40,
  });
  assert.deepEqual(
    turns.map((turn) => turn.text),
    ["earlier", "answer"],
  );
});

test("selectHistoryTurns drops turns after the in-flight message", () => {
  const turns = selectHistoryTurns({
    turns: [
      { role: "user", message_id: "u1", text: "earlier" },
      { role: "assistant", message_id: "a1", text: "answer" },
      { role: "user", message_id: "u2", text: "first question" },
      { role: "user", message_id: "u3", text: "newer question while first hydrates" },
    ],
    currentMessageId: "u2",
    currentText: "first question",
  });
  assert.deepEqual(
    turns.map((turn) => turn.text),
    ["earlier", "answer"],
  );
});

test("selectHistoryTurns drops the newest identical user text when ids are missing", () => {
  const turns = selectHistoryTurns({
    turns: [
      { role: "user", text: "keep" },
      { role: "assistant", text: "ack" },
      { role: "user", text: "same" },
    ],
    currentMessageId: "missing",
    currentText: "same",
  });
  assert.deepEqual(
    turns.map((turn) => turn.text),
    ["keep", "ack"],
  );
});

test("selectHistoryTurns keeps the tail inside the character budget", () => {
  const turns = selectHistoryTurns({
    turns: [
      { role: "user", message_id: "old", text: "x".repeat(50) },
      { role: "assistant", message_id: "mid", text: "y".repeat(50) },
      { role: "user", message_id: "new", text: "z".repeat(40) },
    ],
    currentMessageId: "current",
    currentText: "now",
    charBudget: 120,
  });
  assert.deepEqual(
    turns.map((turn) => turn.text),
    ["y".repeat(50), "z".repeat(40)],
  );
  assert.ok(turns.every((turn) => (turn.text ?? "").length <= AUTO_HISTORY_CHAR_BUDGET));
});

test("planSessionHistoryRestore prepends prior turns for an empty-session caller", () => {
  const turns = [
    { role: "user", message_id: "u1", text: "approve the deploy" },
    { role: "assistant", message_id: "a1", text: "waiting on you" },
    { role: "user", message_id: "u2", text: "what were we talking about?" },
  ];
  const restored = planSessionHistoryRestore({
    turns,
    currentMessageId: "u2",
    currentText: "what were we talking about?",
  });
  assert.equal(restored.restoredTurns, 2);
  assert.ok(restored.text.startsWith(SESSION_HISTORY_BEGIN));
  assert.ok(restored.text.includes("User: approve the deploy"));
  assert.ok(restored.text.includes("Assistant: waiting on you"));
  assert.ok(restored.text.includes(SESSION_HISTORY_END));
  assert.ok(restored.text.endsWith("what were we talking about?"));
});
