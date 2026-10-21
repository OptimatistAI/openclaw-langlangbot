import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, name), "utf8");

function calls(text: string, name: string): string[] {
  const found: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(needle, from);
    if (start < 0) {
      break;
    }
    let depth = 0;
    let end = start + name.length;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          found.push(text.slice(start + needle.length, end));
          break;
        }
      }
    }
    from = end + 1;
  }
  return found;
}

function endsWithTrue(args: string): boolean {
  return /,\s*true\s*,?\s*$/.test(args);
}

test("channel outbound text and media are proactive", () => {
  const channel = source("channel.ts");
  const messages = calls(channel, "sendMessage");
  assert.equal(messages.length, 1);
  assert.equal(endsWithTrue(messages[0] ?? ""), true);
  const files = calls(channel, "sendOutboundFiles");
  assert.equal(files.length, 1);
  assert.equal(endsWithTrue(files[0] ?? ""), true);
});

test("failure notices are proactive and in-turn sends are not", () => {
  const gateway = source("gateway.ts");
  const handleStart = gateway.indexOf("async function handleInbound");
  const statusStart = gateway.indexOf("async function sendOperatorVisibleStatus");
  assert.ok(handleStart >= 0 && statusStart > handleStart);
  const handle = gateway.slice(handleStart, statusStart);
  const status = gateway.slice(statusStart);
  for (const args of calls(handle, "sendMessage")) {
    assert.equal(endsWithTrue(args), false, args);
  }
  for (const args of calls(handle, "sendOutboundFiles")) {
    assert.equal(endsWithTrue(args), false, args);
  }
  const notices = calls(status, "sendMessage");
  assert.equal(notices.length, 1);
  assert.equal(endsWithTrue(notices[0] ?? ""), true);
});

test("outbound files forward the proactive flag", () => {
  const media = source("outbound-media.ts");
  const messages = calls(media, "sendMessage");
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /proactive\s*,?\s*$/);
});
