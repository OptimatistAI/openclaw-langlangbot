import assert from "node:assert/strict";
import test from "node:test";

import {
  appendStreamedBlock,
  blockSeparator,
  isMarkdownSafeTail,
} from "./stream-text.ts";

test("keeps every block when a reply arrives in several segments", () => {
  const first = "我查了一圈，没有找到这个典故。";
  const second = "**容易串的地方：**\n- 甘露寺的“甘露”是孙皓的年号。";

  const afterFirst = appendStreamedBlock("", first);
  const afterSecond = appendStreamedBlock(afterFirst, second);

  assert.ok(afterSecond.includes("我查了一圈"));
  assert.ok(afterSecond.includes("容易串的地方"));
  assert.equal(afterSecond, `${first}\n\n${second}`);
});

test("follows a cumulative payload instead of duplicating it", () => {
  const partial = "前半段";
  const cumulative = "前半段后半段";

  assert.equal(appendStreamedBlock(partial, cumulative), cumulative);
});

test("does not append a block that was already covered", () => {
  const full = "第一段\n\n第二段";

  assert.equal(appendStreamedBlock(full, full), full);
  assert.equal(appendStreamedBlock(full, "第二段"), full);
});

test("starts from the first block unchanged", () => {
  assert.equal(appendStreamedBlock("", "只有一段"), "只有一段");
});

test("a paragraph break stays a blank line", () => {
  assert.equal(blockSeparator("第一段。", "第二段"), "\n\n");
});

test("a split fenced block keeps its newline instead of gaining a blank line", () => {
  const previous = "看这段：\n```ts\nconst a = 1;";

  assert.equal(blockSeparator(previous, "const b = 2;"), "\n");
  assert.equal(isMarkdownSafeTail(previous), false);
});

test("a table split mid-way is joined with a single newline", () => {
  const previous = "| 场景 | 结果 |\n| --- | --- |\n| 长回答 | 只收到尾巴 |";

  assert.equal(blockSeparator(previous, "| 修复后 | 全文 |"), "\n");
  assert.equal(isMarkdownSafeTail(previous), false);
});

test("list and quote continuations stay tight", () => {
  assert.equal(blockSeparator("- 第一项", "- 第二项"), "\n");
  assert.equal(blockSeparator("> 引用第一行", "> 引用第二行"), "\n");
  assert.equal(isMarkdownSafeTail("- 第一项"), false);
});

test("a heading or closed fence is followed by a blank line", () => {
  assert.equal(blockSeparator("## 三、验证数据", "npm test 24 passed"), "\n\n");
  assert.equal(blockSeparator("```ts\nconst a = 1;\n```", "后面是正文"), "\n\n");
  assert.equal(isMarkdownSafeTail("```ts\nconst a = 1;\n```"), true);
});

test("mid-sentence splits glue CJK but keep a space between latin words", () => {
  assert.equal(blockSeparator("这是被截断的句", "子的后半截"), "");
  assert.equal(blockSeparator("the reply was cut", "in the middle"), " ");
});

test("a decimal point or code syntax never becomes a paragraph break", () => {
  assert.equal(blockSeparator('Mountain(name: "金山", height: 43.', '7),'), "\n");
  assert.equal(blockSeparator("版本 v1.2", "3 修正了一点"), "");
  assert.equal(blockSeparator("表格到这里 |", "| 下一行"), "\n");
});

test("a table row continues even when the next block starts with a pipe", () => {
  assert.equal(blockSeparator("| 北固山 | 镇江东北江滨", "| 孙权、刘备 |"), "\n");
});
