import { describe, it, expect } from "vitest";
import { parseDiscordMarkdown, MentionResolver } from "./markdown";

const resolver: MentionResolver = {
  user: (id) => (id === "123" ? "Иван" : undefined),
  channel: (id) => (id === "456" ? "general" : undefined),
  role: (id) => (id === "789" ? "admin" : undefined),
};

describe("parseDiscordMarkdown — basic markers", () => {
  it("bold", () => {
    expect(parseDiscordMarkdown("**bold**")).toEqual({
      text: "bold",
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
  });

  it("italic with * and _", () => {
    expect(parseDiscordMarkdown("*italic*")).toEqual({
      text: "italic",
      entities: [{ type: "italic", offset: 0, length: 6 }],
    });
    expect(parseDiscordMarkdown("_italic_")).toEqual({
      text: "italic",
      entities: [{ type: "italic", offset: 0, length: 6 }],
    });
  });

  it("underline is not confused with single-underscore italic", () => {
    expect(parseDiscordMarkdown("__under__")).toEqual({
      text: "under",
      entities: [{ type: "underline", offset: 0, length: 5 }],
    });
  });

  it("strikethrough, spoiler, inline code", () => {
    expect(parseDiscordMarkdown("~~s~~")).toEqual({
      text: "s",
      entities: [{ type: "strikethrough", offset: 0, length: 1 }],
    });
    expect(parseDiscordMarkdown("||sp||")).toEqual({
      text: "sp",
      entities: [{ type: "spoiler", offset: 0, length: 2 }],
    });
    expect(parseDiscordMarkdown("`c`")).toEqual({
      text: "c",
      entities: [{ type: "code", offset: 0, length: 1 }],
    });
  });

  it("does not italicize snake_case identifiers", () => {
    expect(parseDiscordMarkdown("snake_case_var")).toEqual({
      text: "snake_case_var",
      entities: [],
    });
  });
});

describe("parseDiscordMarkdown — code blocks", () => {
  it("fenced block with language", () => {
    expect(parseDiscordMarkdown("```js\nconst x=1\n```")).toEqual({
      text: "const x=1",
      entities: [{ type: "pre", offset: 0, length: 9, language: "js" }],
    });
  });

  it("fenced block without language", () => {
    expect(parseDiscordMarkdown("```\ncode```")).toEqual({
      text: "code",
      entities: [{ type: "pre", offset: 0, length: 4 }],
    });
  });

  it("does not parse markdown inside a code block", () => {
    expect(parseDiscordMarkdown("```\n**not bold**\n```")).toEqual({
      text: "**not bold**",
      entities: [{ type: "pre", offset: 0, length: 12 }],
    });
  });

  it("does not parse markdown inside inline code", () => {
    const r = parseDiscordMarkdown("`**x**`");
    expect(r.text).toBe("**x**");
    expect(r.entities).toEqual([{ type: "code", offset: 0, length: 5 }]);
  });
});

describe("parseDiscordMarkdown — quotes and links", () => {
  it("renders headings (#/##/###) as bold", () => {
    expect(parseDiscordMarkdown("## Title")).toEqual({
      text: "Title",
      entities: [{ type: "bold", offset: 0, length: 5 }],
    });
    // Only at line start, and not a bare '#'.
    expect(parseDiscordMarkdown("a ## b").entities).toEqual([]);
  });

  it("single-line blockquote", () => {
    expect(parseDiscordMarkdown("> quote")).toEqual({
      text: "quote",
      entities: [{ type: "blockquote", offset: 0, length: 5 }],
    });
  });

  it("triple blockquote runs to the end", () => {
    const r = parseDiscordMarkdown(">>> a\nb");
    expect(r.text).toBe("a\nb");
    expect(r.entities).toEqual([{ type: "blockquote", offset: 0, length: 3 }]);
  });

  it("markdown link", () => {
    expect(parseDiscordMarkdown("[Google](https://g.co)")).toEqual({
      text: "Google",
      entities: [{ type: "link", offset: 0, length: 6, url: "https://g.co" }],
    });
  });

  it("bare autolink with correct offset and no trailing punctuation", () => {
    const r = parseDiscordMarkdown("see https://x.io now");
    expect(r.text).toBe("see https://x.io now");
    expect(r.entities).toEqual([
      { type: "link", offset: 4, length: 12, url: "https://x.io" },
    ]);
    const dot = parseDiscordMarkdown("go https://x.io.");
    expect(dot.entities[0]).toMatchObject({ url: "https://x.io" });
  });
});

describe("parseDiscordMarkdown — mentions", () => {
  it("user mention resolves to a readable name", () => {
    expect(parseDiscordMarkdown("<@123>", resolver)).toEqual({
      text: "@Иван",
      entities: [{ type: "mention", offset: 0, length: 5 }],
    });
  });

  it("nickname form <@!id> behaves like <@id>", () => {
    expect(parseDiscordMarkdown("<@!123>", resolver).text).toBe("@Иван");
  });

  it("channel and role mentions", () => {
    expect(parseDiscordMarkdown("<#456>", resolver).text).toBe("#general");
    expect(parseDiscordMarkdown("<@&789>", resolver).text).toBe("@admin");
  });

  it("falls back to the id without a resolver", () => {
    expect(parseDiscordMarkdown("<@123>")).toEqual({
      text: "@123",
      entities: [{ type: "mention", offset: 0, length: 4 }],
    });
  });

  it("custom emoji becomes :name: with no entity", () => {
    expect(parseDiscordMarkdown("<:party:123> hi")).toEqual({
      text: ":party: hi",
      entities: [],
    });
    expect(parseDiscordMarkdown("<a:wave:99>").text).toBe(":wave:");
  });
});

describe("parseDiscordMarkdown — nesting and offsets", () => {
  it("nested bold+italic yields two overlapping entities", () => {
    expect(parseDiscordMarkdown("**_bt_**")).toEqual({
      text: "bt",
      entities: [
        { type: "bold", offset: 0, length: 2 },
        { type: "italic", offset: 0, length: 2 },
      ],
    });
  });

  it("multiple non-overlapping entities get correct offsets", () => {
    const r = parseDiscordMarkdown("a **b** c *d*");
    expect(r.text).toBe("a b c d");
    expect(r.entities).toEqual([
      { type: "bold", offset: 2, length: 1 },
      { type: "italic", offset: 6, length: 1 },
    ]);
  });
});

describe("parseDiscordMarkdown — UTF-16 correctness", () => {
  it("counts Cyrillic as one code unit each", () => {
    expect(parseDiscordMarkdown("**привет**")).toEqual({
      text: "привет",
      entities: [{ type: "bold", offset: 0, length: 6 }],
    });
  });

  it("counts an astral emoji as two code units", () => {
    // "😀" is 2 UTF-16 units, then a space → bold starts at offset 3.
    const r = parseDiscordMarkdown("😀 **b**");
    expect(r.text).toBe("😀 b");
    expect(r.entities).toEqual([{ type: "bold", offset: 3, length: 1 }]);
  });

  it("custom emoji replacement shifts later offsets by the output length", () => {
    const r = parseDiscordMarkdown("<:hi:1> **b**");
    expect(r.text).toBe(":hi: b");
    expect(r.entities).toEqual([{ type: "bold", offset: 5, length: 1 }]);
  });
});

describe("parseDiscordMarkdown — escaping and robustness", () => {
  it("backslash escapes markers", () => {
    expect(parseDiscordMarkdown("\\*not italic\\*")).toEqual({
      text: "*not italic*",
      entities: [],
    });
  });

  it("unclosed marker is treated as a literal", () => {
    expect(parseDiscordMarkdown("**oops")).toEqual({
      text: "**oops",
      entities: [],
    });
  });

  it("empty input", () => {
    expect(parseDiscordMarkdown("")).toEqual({ text: "", entities: [] });
  });
});
