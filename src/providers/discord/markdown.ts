/**
 * Discord sends raw markdown text in a message's `content`. This pure parser
 * turns it into plain text + provider-agnostic `MessageEntity[]` (ADR-004), the
 * same model Telegram/WhatsApp map into and the webview renders (`renderRichText`
 * in media/conversation.js). No Discord/vscode imports, so it unit-tests in
 * isolation.
 *
 * Offsets/lengths are UTF-16 code units over the OUTPUT string (markers stripped,
 * mentions expanded to readable text). Nesting produces a flat list of
 * overlapping ranges — the webview combines them, so no tree is needed.
 */
import type { MessageEntity } from "../types";

export interface ParsedText {
  text: string;
  entities: MessageEntity[];
}

/** Resolves Discord ids to readable names for `<@id>` / `<#id>` / `<@&id>`. */
export interface MentionResolver {
  user?(id: string): string | undefined;
  channel?(id: string): string | undefined;
  role?(id: string): string | undefined;
}

/** One matched construct: how much input it consumed, the text it produces, and
 *  entities with offsets relative to that produced text. */
interface Match {
  len: number;
  text: string;
  entities: MessageEntity[];
}

export function parseDiscordMarkdown(
  raw: string,
  resolve?: MentionResolver
): ParsedText {
  return parseInline(raw ?? "", resolve);
}

function parseInline(input: string, resolve?: MentionResolver): ParsedText {
  let out = "";
  const entities: MessageEntity[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    // Backslash escapes the next character (it renders literally).
    if (input[i] === "\\" && i + 1 < n) {
      out += input[i + 1];
      i += 2;
      continue;
    }
    const m = matchConstruct(input, i, resolve);
    if (m) {
      const base = out.length;
      out += m.text;
      for (const e of m.entities) {
        entities.push({ ...e, offset: e.offset + base });
      }
      i += m.len;
      continue;
    }
    out += input[i];
    i += 1;
  }

  return { text: out, entities };
}

/** Try every construct at position `i`, longest/most-specific first. */
function matchConstruct(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  return (
    heading(input, i, resolve) ??
    blockquote(input, i, resolve) ??
    codeBlock(input, i) ??
    inlineCode(input, i) ??
    paired(input, i, "||", "spoiler", resolve) ??
    paired(input, i, "**", "bold", resolve) ??
    paired(input, i, "__", "underline", resolve) ??
    paired(input, i, "~~", "strikethrough", resolve) ??
    paired(input, i, "*", "italic", resolve) ??
    italicUnderscore(input, i, resolve) ??
    imageMd(input, i, resolve) ??
    linkMd(input, i, resolve) ??
    autolink(input, i) ??
    mention(input, i, resolve)
  );
}

/** A paired inline marker (`**bold**`, `~~s~~`, `||sp||`, `*i*`). Inner content
 *  is parsed recursively so nested formatting works. */
function paired(
  input: string,
  i: number,
  marker: string,
  type: MessageEntity["type"],
  resolve?: MentionResolver
): Match | null {
  if (!input.startsWith(marker, i)) {
    return null;
  }
  const contentStart = i + marker.length;
  const end = input.indexOf(marker, contentStart);
  if (end === -1 || end === contentStart) {
    return null; // unclosed or empty → treat the marker literally
  }
  const inner = parseInline(input.slice(contentStart, end), resolve);
  return {
    len: end + marker.length - i,
    text: inner.text,
    entities: [
      { type, offset: 0, length: inner.text.length },
      ...inner.entities,
    ],
  };
}

/** `_italic_` — underscore italic requires word boundaries so it doesn't fire on
 *  snake_case identifiers (common when sharing code). */
function italicUnderscore(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  if (input[i] !== "_" || input[i + 1] === "_") {
    return null;
  }
  const before = i === 0 ? "" : input[i - 1];
  if (before && /\w/.test(before)) {
    return null; // mid-word underscore, e.g. snake_case
  }
  let j = i + 1;
  while (j < input.length) {
    if (input[j] === "_") {
      const after = input[j + 1] ?? "";
      if (!after || !/\w/.test(after)) {
        break;
      }
    }
    j += 1;
  }
  if (j >= input.length || j === i + 1) {
    return null;
  }
  const inner = parseInline(input.slice(i + 1, j), resolve);
  return {
    len: j + 1 - i,
    text: inner.text,
    entities: [
      { type: "italic", offset: 0, length: inner.text.length },
      ...inner.entities,
    ],
  };
}

/** Inline code: a run of 1–2 backticks; content is literal (no nested markdown). */
function inlineCode(input: string, i: number): Match | null {
  if (input[i] !== "`" || input.startsWith("```", i)) {
    return null; // ``` is a code block, handled separately
  }
  let run = 0;
  while (input[i + run] === "`") {
    run += 1;
  }
  const fence = "`".repeat(run);
  const contentStart = i + run;
  const end = input.indexOf(fence, contentStart);
  if (end === -1 || end === contentStart) {
    return null;
  }
  let inner = input.slice(contentStart, end);
  // Discord trims a single wrapping space (so `` ` `` can hold a backtick).
  if (inner.startsWith(" ") && inner.endsWith(" ") && inner.trim().length) {
    inner = inner.slice(1, -1);
  }
  return {
    len: end + run - i,
    text: inner,
    entities: [{ type: "code", offset: 0, length: inner.length }],
  };
}

/** Fenced code block ```` ```lang\n…``` ````; content literal, optional language. */
function codeBlock(input: string, i: number): Match | null {
  if (!input.startsWith("```", i)) {
    return null;
  }
  const contentStart = i + 3;
  const end = input.indexOf("```", contentStart);
  if (end === -1) {
    return null;
  }
  let inner = input.slice(contentStart, end);
  let language: string | undefined;
  const nl = inner.indexOf("\n");
  if (nl !== -1) {
    const firstLine = inner.slice(0, nl);
    if (/^[A-Za-z0-9+#.-]+$/.test(firstLine)) {
      language = firstLine;
      inner = inner.slice(nl + 1);
    } else if (firstLine === "") {
      inner = inner.slice(1); // leading newline, no language
    }
  }
  if (inner.endsWith("\n")) {
    inner = inner.slice(0, -1); // Discord strips the trailing newline
  }
  const entity: MessageEntity = { type: "pre", offset: 0, length: inner.length };
  if (language) {
    entity.language = language;
  }
  return { len: end + 3 - i, text: inner, entities: [entity] };
}

/** `# `, `## `, `### ` headings at the start of a line. The webview has no
 *  heading style, so we render them bold. */
function heading(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  const atLineStart = i === 0 || input[i - 1] === "\n";
  if (!atLineStart) {
    return null;
  }
  const m = /^(#{1,3}) /.exec(input.slice(i, i + 5));
  if (!m) {
    return null;
  }
  const eol = input.indexOf("\n", i);
  const end = eol === -1 ? input.length : eol;
  const inner = parseInline(input.slice(i + m[1].length + 1, end), resolve);
  if (!inner.text) {
    return null;
  }
  return {
    len: end - i,
    text: inner.text,
    entities: [
      { type: "bold", offset: 0, length: inner.text.length },
      ...inner.entities,
    ],
  };
}

/** `> quote` (one line) or `>>> quote` (to end); only at the start of a line. */
function blockquote(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  const atLineStart = i === 0 || input[i - 1] === "\n";
  if (!atLineStart) {
    return null;
  }
  if (input.startsWith(">>> ", i)) {
    const inner = parseInline(input.slice(i + 4), resolve);
    return quoteMatch(input.length - i, inner);
  }
  if (input.startsWith("> ", i)) {
    const eol = input.indexOf("\n", i);
    const lineEnd = eol === -1 ? input.length : eol;
    const inner = parseInline(input.slice(i + 2, lineEnd), resolve);
    return quoteMatch(lineEnd - i, inner);
  }
  return null;
}

function quoteMatch(len: number, inner: ParsedText): Match {
  return {
    len,
    text: inner.text,
    entities: [
      { type: "blockquote", offset: 0, length: inner.text.length },
      ...inner.entities,
    ],
  };
}

/** `![alt](url)` — Discord can't inline markdown images, so render it as a
 *  masked link (alt text → url), consuming the leading "!". */
function imageMd(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  if (input[i] !== "!" || input[i + 1] !== "[") {
    return null;
  }
  const link = linkMd(input, i + 1, resolve);
  if (!link) {
    return null;
  }
  return { len: link.len + 1, text: link.text, entities: link.entities };
}

/** `[text](url)` — the visible text may itself be formatted. */
function linkMd(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  if (input[i] !== "[") {
    return null;
  }
  const close = input.indexOf("]", i + 1);
  if (close === -1 || input[close + 1] !== "(") {
    return null;
  }
  const urlEnd = input.indexOf(")", close + 2);
  if (urlEnd === -1) {
    return null;
  }
  const url = input.slice(close + 2, urlEnd);
  if (!url) {
    return null;
  }
  const inner = parseInline(input.slice(i + 1, close), resolve);
  return {
    len: urlEnd + 1 - i,
    text: inner.text,
    entities: [
      { type: "link", offset: 0, length: inner.text.length, url },
      ...inner.entities,
    ],
  };
}

/** A bare http(s) URL. */
function autolink(input: string, i: number): Match | null {
  if (!/^https?:\/\//.test(input.slice(i, i + 8))) {
    return null;
  }
  const m = /^https?:\/\/[^\s<]+/.exec(input.slice(i));
  if (!m) {
    return null;
  }
  // Don't swallow trailing sentence punctuation.
  const url = m[0].replace(/[.,!?)]+$/, "");
  if (!url) {
    return null;
  }
  return {
    len: url.length,
    text: url,
    entities: [{ type: "link", offset: 0, length: url.length, url }],
  };
}

/** `<@id>` / `<@!id>` (user), `<#id>` (channel), `<@&id>` (role), and custom
 *  emoji `<:name:id>` / `<a:name:id>` (rendered as `:name:`, no entity). */
function mention(
  input: string,
  i: number,
  resolve?: MentionResolver
): Match | null {
  if (input[i] !== "<") {
    return null;
  }
  const close = input.indexOf(">", i + 1);
  if (close === -1) {
    return null;
  }
  const body = input.slice(i + 1, close);
  const len = close + 1 - i;
  let m: RegExpExecArray | null;

  if ((m = /^@!?(\d+)$/.exec(body))) {
    const text = "@" + (resolve?.user?.(m[1]) ?? m[1]);
    return mentionMatch(len, text);
  }
  if ((m = /^#(\d+)$/.exec(body))) {
    const text = "#" + (resolve?.channel?.(m[1]) ?? m[1]);
    return mentionMatch(len, text);
  }
  if ((m = /^@&(\d+)$/.exec(body))) {
    const text = "@" + (resolve?.role?.(m[1]) ?? m[1]);
    return mentionMatch(len, text);
  }
  if ((m = /^a?:(\w+):(\d+)$/.exec(body))) {
    // Custom emoji → a plain :name: token, no entity (the webview has no emoji type).
    return { len, text: ":" + m[1] + ":", entities: [] };
  }
  return null;
}

function mentionMatch(len: number, text: string): Match {
  return {
    len,
    text,
    entities: [{ type: "mention", offset: 0, length: text.length }],
  };
}
