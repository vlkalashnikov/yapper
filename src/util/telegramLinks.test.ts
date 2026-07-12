import { describe, it, expect } from "vitest";
import { parseTelegramLink } from "./telegramLinks";

describe("parseTelegramLink", () => {
  it("parses a public t.me username link", () => {
    expect(parseTelegramLink("https://t.me/durov")).toEqual({
      username: "durov",
      messageId: undefined,
    });
  });

  it("parses a t.me link with a message id", () => {
    expect(parseTelegramLink("https://t.me/telegram/42")).toEqual({
      username: "telegram",
      messageId: 42,
    });
  });

  it("tolerates a trailing slash and query string", () => {
    expect(parseTelegramLink("http://t.me/durov/?foo=bar")).toEqual({
      username: "durov",
      messageId: undefined,
    });
  });

  it("parses a tg://resolve deep link", () => {
    expect(parseTelegramLink("tg://resolve?domain=durov")).toEqual({
      username: "durov",
    });
  });

  it("ignores reserved paths (invites, stickers, etc.)", () => {
    expect(parseTelegramLink("https://t.me/joinchat/AAA")).toBeUndefined();
    expect(parseTelegramLink("https://t.me/addstickers/pack")).toBeUndefined();
    expect(parseTelegramLink("https://t.me/s/durov")).toBeUndefined();
  });

  it("returns undefined for non-Telegram or malformed URLs", () => {
    expect(parseTelegramLink("https://example.com/durov")).toBeUndefined();
    expect(parseTelegramLink("https://t.me/ab")).toBeUndefined(); // too short
    expect(parseTelegramLink("not a url")).toBeUndefined();
  });
});
