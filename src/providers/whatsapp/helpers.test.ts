import { describe, it, expect } from "vitest";
import type { Contact, WAMessage } from "@whiskeysockets/baileys";
import {
  chatTitle,
  isGroupJid,
  isRenderable,
  extFromMime,
  isSupportedJid,
  jidUser,
  mapStatus,
  mediaInfo,
  messageText,
  mimeOf,
  monospaceBlock,
  muteActive,
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
    expect(isSupportedJid("123@lid")).toBe(true);
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

describe("wrapped (container) messages", () => {
  it("unwraps disappearing (ephemeral) text", () => {
    const m = wa({
      message: { ephemeralMessage: { message: { conversation: "poof" } } },
    });
    expect(messageText(m)).toBe("poof");
    expect(isRenderable(m)).toBe(true);
  });
  it("unwraps view-once media (renderable, no text)", () => {
    const m = wa({
      message: { viewOnceMessageV2: { message: { imageMessage: {} } } },
    });
    expect(isRenderable(m)).toBe(true);
    expect(messageText(m)).toBe("");
  });
  it("unwraps a message sent from another device", () => {
    const m = wa({
      message: { deviceSentMessage: { message: { conversation: "hey" } } },
    });
    expect(messageText(m)).toBe("hey");
  });
  it("unwraps nested containers (ephemeral → view-once)", () => {
    const m = wa({
      message: {
        ephemeralMessage: {
          message: { viewOnceMessageV2: { message: { conversation: "deep" } } },
        },
      },
    });
    expect(messageText(m)).toBe("deep");
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

describe("mapStatus", () => {
  it("maps WhatsApp delivery status to read-receipt state", () => {
    expect(mapStatus(0)).toBeUndefined(); // ERROR
    expect(mapStatus(1)).toBeUndefined(); // PENDING
    expect(mapStatus(2)).toBe("sent"); // SERVER_ACK → ✓
    expect(mapStatus(3)).toBe("read"); // DELIVERY_ACK → ✓✓ (delivered)
    expect(mapStatus(4)).toBe("read"); // READ
    expect(mapStatus(5)).toBe("read"); // PLAYED
    expect(mapStatus(null)).toBeUndefined();
    expect(mapStatus(undefined)).toBeUndefined();
  });
});

describe("monospaceBlock", () => {
  it("strips a full triple-backtick wrap into a pre entity", () => {
    const r = monospaceBlock("```const x = 1;```");
    expect(r.text).toBe("const x = 1;");
    expect(r.entities).toEqual([{ type: "pre", offset: 0, length: 12 }]);
  });
  it("handles surrounding newlines and multiline code", () => {
    const r = monospaceBlock("```\nline1\nline2\n```");
    expect(r.text).toBe("line1\nline2");
    expect(r.entities?.[0].length).toBe(11);
  });
  it("leaves plain text (and single backticks) untouched", () => {
    expect(monospaceBlock("hello")).toEqual({ text: "hello" });
    expect(monospaceBlock("use `x` here")).toEqual({ text: "use `x` here" });
  });
  it("marks an inline fragment as code, stripping the backticks", () => {
    const r = monospaceBlock("привет ```мир```, как дела");
    expect(r.text).toBe("привет мир, как дела");
    expect(r.entities).toEqual([{ type: "code", offset: 7, length: 3 }]);
  });
  it("marks multiple inline fragments", () => {
    const r = monospaceBlock("```a``` and ```bb```");
    expect(r.text).toBe("a and bb");
    expect(r.entities).toEqual([
      { type: "code", offset: 0, length: 1 },
      { type: "code", offset: 6, length: 2 },
    ]);
  });
});

describe("mediaInfo", () => {
  it("classifies video vs gif and carries the caption", () => {
    expect(mediaInfo({ videoMessage: { caption: "clip" } })).toMatchObject({
      hasImage: true,
      mediaKind: "video",
      caption: "clip",
    });
    expect(mediaInfo({ videoMessage: { gifPlayback: true } })).toMatchObject({
      mediaKind: "gif",
    });
  });
  it("maps a voice note to a file chip", () => {
    expect(mediaInfo({ audioMessage: { ptt: true } }).file?.name).toBe(
      "Voice message.ogg"
    );
  });
  it("unwraps a container before classifying", () => {
    expect(
      mediaInfo({ ephemeralMessage: { message: { stickerMessage: {} } } })
    ).toMatchObject({ hasImage: true, mediaKind: "sticker" });
  });
  it("is empty for plain text", () => {
    expect(mediaInfo({ conversation: "hi" })).toEqual({});
  });
});

describe("extFromMime", () => {
  it("derives extensions, stripping params and x- prefix", () => {
    expect(extFromMime("image/jpeg")).toBe("jpeg");
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extFromMime("video/quicktime")).toBe("mov");
    expect(extFromMime("garbage")).toBe("");
  });
});

describe("mimeOf", () => {
  it("maps source/text files to text/plain (open inline)", () => {
    expect(mimeOf("main.ts")).toBe("text/plain");
    expect(mimeOf("a.diff")).toBe("text/plain");
    expect(mimeOf("notes.md")).toBe("text/markdown");
  });
  it("maps common binary types", () => {
    expect(mimeOf("doc.pdf")).toBe("application/pdf");
    expect(mimeOf("pic.PNG")).toBe("image/png");
  });
  it("falls back to octet-stream for unknown or extension-less names", () => {
    expect(mimeOf("archive.xyz")).toBe("application/octet-stream");
    expect(mimeOf("Makefile")).toBe("application/octet-stream");
  });
});

describe("muteActive", () => {
  const now = 1_700_000_000_000; // ms
  it("treats 0/absent as not muted", () => {
    expect(muteActive(0, now)).toBe(false);
  });
  it("treats a negative end time as muted forever", () => {
    expect(muteActive(-1, now)).toBe(true);
  });
  it("compares a seconds timestamp (normalized to ms)", () => {
    expect(muteActive(now / 1000 + 3600, now)).toBe(true); // 1h ahead
    expect(muteActive(now / 1000 - 3600, now)).toBe(false); // 1h past
  });
  it("compares a millisecond timestamp as-is", () => {
    expect(muteActive(now + 3_600_000, now)).toBe(true);
    expect(muteActive(now - 3_600_000, now)).toBe(false);
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

  it("sets read-receipt status for outgoing 1:1 messages", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({
        key: { id: "M2", fromMe: true, remoteJid: "1@s.whatsapp.net" },
        message: { conversation: "yo" },
        messageTimestamp: 5,
        status: 4,
      }),
      "[media]"
    );
    expect(msg.status).toBe("read");
  });

  it("omits status for incoming and for group messages", () => {
    const incoming = toMessage(
      "1@s.whatsapp.net",
      wa({ ...base, message: { conversation: "hi" }, status: 4 }),
      "[media]"
    );
    expect(incoming.status).toBeUndefined();
    const group = toMessage(
      "g@g.us",
      wa({
        key: { id: "G1", fromMe: true, remoteJid: "g@g.us" },
        message: { conversation: "hey" },
        messageTimestamp: 1,
        status: 4,
      }),
      "[media]"
    );
    expect(group.status).toBeUndefined();
  });

  it("maps media to hasImage/mediaKind (not the text placeholder)", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({ ...base, message: { imageMessage: { caption: "look" } } }),
      "[media]"
    );
    expect(msg.hasImage).toBe(true);
    expect(msg.mediaKind).toBe("photo");
    expect(msg.text).toBe("look"); // caption becomes the text
  });

  it("maps a document to a file chip", () => {
    const msg = toMessage(
      "1@s.whatsapp.net",
      wa({ ...base, message: { documentMessage: { fileName: "a.pdf", fileLength: 1234 } } }),
      "[media]"
    );
    expect(msg.file).toEqual({ name: "a.pdf", size: 1234 });
    expect(msg.text).toBe("");
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
