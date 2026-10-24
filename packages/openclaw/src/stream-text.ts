/**
 * Accumulate the assistant text that the langlangbot turn will deliver.
 *
 * A single reply can reach us as several `block` payloads (OpenClaw splits
 * long replies, e.g. at blank lines). Overwriting the buffer with the newest
 * block dropped every earlier block from the final message, so the client only
 * ever saw the tail of the answer.
 */

const FENCE = "```";
// A paragraph break is only implied by CJK sentence punctuation. An ASCII
// period is far more often a decimal point, a version number or code syntax
// (`43.7`, `v1.2`), so it must never produce a blank line.
const CJK_TERMINATORS = "。！？；：…";
const ASCII_TERMINATORS = ".!?;:";

function lastLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) {
      return lines[i];
    }
  }
  return "";
}

function hasOpenFence(text: string): boolean {
  let fences = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith(FENCE)) {
      fences += 1;
    }
  }
  return fences % 2 === 1;
}

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

/**
 * Separator to use when `next` continues `previous`.
 *
 * OpenClaw trims every block, so the original separators are gone and we have
 * to choose one. A blank line (markdown paragraph break) is only safe where the
 * previous block already ended a block-level structure; inside a table, list,
 * quote or fenced code it would corrupt the markdown.
 */
export function blockSeparator(previous: string, next: string): string {
  if (!previous) {
    return "";
  }
  const tail = lastLine(previous).trim();
  const head = next.trimStart();
  if (hasOpenFence(previous)) {
    return "\n";
  }
  // Anything that continues a block-level structure is joined tightly,
  // whatever the previous block happened to end with.
  if (tail.startsWith("|") || head.startsWith("|")) {
    return "\n";
  }
  if (/^(>|[-*+]\s|\d+[.)]\s)/.test(tail) || /^(>|[-*+]\s|\d+[.)]\s)/.test(head)) {
    return "\n";
  }
  if (tail.startsWith("#") || tail.startsWith(FENCE)) {
    return "\n\n";
  }
  const last = previous.trimEnd().slice(-1);
  if (last && CJK_TERMINATORS.includes(last)) {
    return "\n\n";
  }
  if (last && ASCII_TERMINATORS.includes(last)) {
    return "\n";
  }
  // Mid-sentence: glue CJK text, glue split numbers, but keep a space
  // between latin words.
  const headChar = next.trimStart()[0];
  if (last && /[0-9]/.test(last) && headChar !== undefined && /[0-9]/.test(headChar)) {
    return "";
  }
  if (isAsciiWordChar(last) && isAsciiWordChar(headChar)) {
    return " ";
  }
  return "";
}

/** True when a following block may be appended without corrupting markdown. */
export function isMarkdownSafeTail(text: string): boolean {
  if (hasOpenFence(text)) {
    return false;
  }
  const tail = lastLine(text).trim();
  if (tail.startsWith("|")) {
    return false;
  }
  return !/^(>|[-*+]\s|\d+[.)]\s)/.test(tail);
}

export function appendStreamedBlock(previous: string, text: string): string {
  if (!previous) {
    return text;
  }
  if (text === previous || previous.endsWith(text)) {
    // Resent / already-contained block: nothing new to add.
    return previous;
  }
  if (text.startsWith(previous)) {
    // Cumulative payload: the newest block already holds everything.
    return text;
  }
  return `${previous}${blockSeparator(previous, text)}${text}`;
}
