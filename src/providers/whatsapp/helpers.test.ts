import { describe, it, expect } from "vitest";
import type { Contact, WAMessage } from "@whiskeysockets/baileys";
import {
  chatTitle,
  isGroupJid,
  isRenderable,
  isSupportedJid,
  jidUser,
  messageText,
  toMessage,
  toNum,
} from "./helpers";

const wa = (m: unknown): WAMessage => m as WAMessage;
const contact = (c: unknown): Contact => c as Contact;

describe("toNum", () => {
  it("passes numbers, converts Long, defaults to 0", () => {
    expect(toNum(1700000000)).toBe(1700000000);
    expect(toNum({ toNumber: () => 42 })).toBe(42);
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });
});

describe("jid helpers", () => {
  it("classifies supported jids (1:1 and groups only)", () => {
    expect(isSupportedJid("123@s.whatsapp.net")).toBe(true);
    expect(isSupportedJid("123-456@g.us")).toBe(true);
    expect(isSupportedJid("status@broadcast")).toBe(false);
    expect(isSupportedJid("123@newsletter")).toBe(false);
  });
  it("detects groups", () => {
    expect(isGroupJid("1-2@g.us")).toBe(true);
    expect(isGroupJid("1@s.whatsapp.net")).toBe(false);
  });
  it("extracts the user part, dropping device suffix", () => {
    expect(jidUser("12345@s.whatsapp.net")).toBe("12345");
    expect(jidUser("12345:6@s.whatsapp.net")).toBe("12345");
  });
});

describe("messageText", () => {
  it("reads conversation and extended text", () => {
    expect(messageText(wa({ message: { conversation: "hi" } }))).toBe("hi");
    expect(
      messageText(wa({ message: { extendedTextMessage: { text: "yo" } } }))
    ).toBe("yo");
  });
  it("returns empty for media or no message", () => {
    expect(messageText(wa({ message: { imageMessage: {} } }))).toBe("");
    expect(messageText(wa({}))).toBe("");
  });
});

describe("isRenderable", () => {
  it("true for text and known media, false for protocol/none", () => {
    expect(isRenderable(wa({ message: { conversation: "hi" } }))).toBe(true);
    expect(isRenderable(wa({ message: { imageMessage: {} } }))).toBe(true);
    expect(
      isRenderable(wa({ message: { senderKeyDistributionMessage: {} } }))
    ).toBe(false);
    expect(isRenderable(wa({}))).toBe(false);
  });
});

describe("chatTitle", () => {
  it("prefers WA name, then contact fields, then the jid user", () => {
    expect(chatTitle("1@s.whatsapp.net", "Group", undefined)).toBe("Group");
    expect(
      chatTitle("1@s.whatsapp.net", undefined, contact({ id: "1", name: "Alice" }))
    ).toBe("Alice");
    expect(
      chatTitle("1@s.whatsapp.net", undefined, contact({ id: "1", notify: "al" }))
    ).toBe("al");
    expect(chatTitle("12345@s.whatsapp.net", undefined, undefined)).toBe("12345");
  });
});

describe("toMessage", () => {
  const base = {
    key: { id: "M1", remoteJid: "1@s.whatsapp.net" },
    messageTimestamp: 1700,
  };

  it("maps an incoming text message", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({ ...base, message: { conversation: "hi" }, pushName: "Alice" }),
      "[media]"
    );
    expect(msg).toMatchObject({
      id: "M1",
      chatId: "1@s.whatsapp.net",
      author: "Alice",
      text: "hi",
      outgoing: false,
      timestamp: 1700000,
    });
  });

  it("marks outgoing and hides the author", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({
        key: { id: "M2", fromMe: true, remoteJid: "1@s.whatsapp.net" },
        message: { conversation: "yo" },
        messageTimestamp: 5,
      }),
      "[media]"
    );
    expect(msg.outgoing).toBe(true);
    expect(msg.author).toBe("");
  });

  it("uses the media placeholder when there is no text", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({ ...base, message: { imageMessage: {} } }),
      "[media]"
    );
    expect(msg.text).toBe("[media]");
  });

  it("falls back to the group participant for the author", () => {
    const msg = toMessage(
      "g@g.us",
      wa({
        key: { id: "M3", remoteJid: "g@g.us", participant: "999@s.whatsapp.net" },
        message: { conversation: "hey" },
        messageTimestamp: 1,
      }),
      "[media]"
    );
    expect(msg.senderId).toBe("999@s.whatsapp.net");
    expect(msg.author).toBe("999");
  });
});
