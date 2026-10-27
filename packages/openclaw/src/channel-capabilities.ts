/**
 * What the LangLang Operator client can actually render.
 *
 * Kept in one dependency-free module so the channel wiring and the tests read
 * the same source of truth: if the client gains or loses a markdown surface,
 * this file changes and both the plugin and the assertions move with it.
 */

/** Operator renders markdown, so OpenClaw must not flatten tool output. */
export const MARKDOWN_CAPABLE = true;

/** Keep tables as markdown tables; never downgrade them to bullets or code. */
export const MARKDOWN_TABLE_MODE = "block" as const;

/**
 * Rendered into the inbound trusted-metadata block as `response_format`
 * (`agentPrompt.inboundFormattingHints`), so it reaches the model on every
 * inbound message rather than only when the `message` tool exists.
 */
export const OPERATOR_FORMATTING_HINTS: { text_markup: string; rules: string[] } = {
  text_markup: "markdown",
  rules: [
    "Operator renders GitHub-flavoured markdown: headings, nested and task lists, blockquotes, pipe tables, inline code, fenced code with syntax highlighting, bold/italic/strikethrough, and [links](url).",
    "Prefer markdown structure over plain text: put comparisons in a real pipe table instead of space-aligned columns.",
    "Put command output, diffs and file excerpts in fenced code blocks with a language tag.",
  ],
};
