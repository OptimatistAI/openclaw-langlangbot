import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MARKDOWN_CAPABLE,
  MARKDOWN_TABLE_MODE,
  OPERATOR_FORMATTING_HINTS,
} from "./channel-capabilities.ts";

test("declares the channel markdown capable", () => {
  assert.equal(MARKDOWN_CAPABLE, true);
});

test("keeps tables as markdown instead of downgrading them", () => {
  assert.equal(MARKDOWN_TABLE_MODE, "block");
});

test("tells the model which markup Operator renders", () => {
  assert.equal(OPERATOR_FORMATTING_HINTS.text_markup, "markdown");
  assert.ok(OPERATOR_FORMATTING_HINTS.rules.length >= 4);
  const joined = OPERATOR_FORMATTING_HINTS.rules.join("\n");
  assert.match(joined, /pipe table/);
  assert.match(joined, /fenced code/i);
  assert.match(joined, /NO_REPLY/);
});

// The constants above are worthless if the channel stops using them, so pin the
// wiring too. channel.ts itself cannot be imported here: it pulls in the gateway
// and connector modules, which only resolve inside a built bundle.
test("channel wiring uses the shared capability constants", () => {
  const source = readFileSync(new URL("./channel.ts", import.meta.url), "utf8");
  assert.match(source, /import \{[\s\S]*?MARKDOWN_CAPABLE[\s\S]*?\} from "\.\/channel-capabilities\.js";/);
  assert.match(source, /\bmarkdownCapable: MARKDOWN_CAPABLE\b/);
  assert.match(source, /\bdefaultMarkdownTableMode: MARKDOWN_TABLE_MODE\b/);
  assert.match(source, /\binboundFormattingHints: \(\) => OPERATOR_FORMATTING_HINTS\b/);
  // messageToolHints only reaches the model when the `message` tool exists, which
  // this direct channel does not get outside message-tool delivery modes. Its
  // guidance lives in the langlangbot-channel skill; don't reintroduce dead
  // prompt code here. (The word may still appear in comments explaining why.)
  assert.doesNotMatch(source, /^\s*messageToolHints:/m);
});
