import { describe, it, expect } from "vitest";
import { Api } from "telegram";
import {
  canSendTo,
  extFromMime,
  extOf,
  isMuted,
  mapEntities,
  matchesFolderFlags,
} from "./helpers";

describe("extOf", () => {
  it("returns the extension without the dot", () => {
    expect(extOf("report.pdf")).toBe("pdf");
    expect(extOf("a.b.tar.gz")).toBe("gz");
  });
  it("returns empty for names without an extension", () => {
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe(""); // leading dot only
  });
});

describe("extFromMime", () => {
  it("maps known containers to friendly extensions", () => {
    expect(extFromMime("video/quicktime")).toBe("mov");
    expect(extFromMime("video/x-matroska")).toBe("mkv");
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("audio/mp4a-latm")).toBe("m4a");
  });
  it("falls back to the subtype, stripping x- and parameters", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extFromMime("video/x-msvideo")).toBe("msvideo");
  });
  it("returns empty when no subtype is present", () => {
    expect(extFromMime("application")).toBe("");
  });
});

describe("isMuted", () => {
  const now = Math.floor(Date.now() / 1000);
  it("is true when muteUntil is in the future", () => {
    expect(isMuted(new Api.PeerNotifySettings({ muteUntil: now + 10_000 }))).toBe(true);
  });
  it("is false when muteUntil is in the past", () => {
    expect(isMuted(new Api.PeerNotifySettings({ muteUntil: now - 10_000 }))).toBe(false);
  });
  it("is false without settings or muteUntil", () => {
    expect(isMuted(undefined)).toBe(false);
    expect(isMuted(new Api.PeerNotifySettings({}))).toBe(false);
  });
});

describe("mapEntities", () => {
  it("returns undefined when there are no entities", () => {
    expect(mapEntities("hi", undefined)).toBeUndefined();
    expect(mapEntities("hi", [])).toBeUndefined();
  });

  it("maps simple formatting to the agnostic model", () => {
    const out = mapEntities("bold", [
      new Api.MessageEntityBold({ offset: 0, length: 4 }),
    ]);
    expect(out).toEqual([{ offset: 0, length: 4, type: "bold" }]);
  });

  it("carries the language for pre blocks (empty → undefined)", () => {
    const withLang = mapEntities("code", [
      new Api.MessageEntityPre({ offset: 0, length: 4, language: "js" }),
    ]);
    expect(withLang).toEqual([{ offset: 0, length: 4, type: "pre", language: "js" }]);
    const noLang = mapEntities("code", [
      new Api.MessageEntityPre({ offset: 0, length: 4, language: "" }),
    ]);
    expect(noLang?.[0].language).toBeUndefined();
  });

  it("derives URLs for links, mentions and emails", () => {
    const textUrl = mapEntities("here", [
      new Api.MessageEntityTextUrl({ offset: 0, length: 4, url: "https://x.com" }),
    ]);
    expect(textUrl?.[0]).toMatchObject({ type: "link", url: "https://x.com" });

    const mention = mapEntities("@durov", [
      new Api.MessageEntityMention({ offset: 0, length: 6 }),
    ]);
    expect(mention?.[0]).toMatchObject({ type: "mention", url: "https://t.me/durov" });

    const email = mapEntities("me@x.com", [
      new Api.MessageEntityEmail({ offset: 0, length: 8 }),
    ]);
    expect(email?.[0]).toMatchObject({ type: "link", url: "mailto:me@x.com" });
  });

  it("skips unsupported entity kinds", () => {
    const out = mapEntities("$USD", [
      new Api.MessageEntityCashtag({ offset: 0, length: 4 }),
    ]);
    expect(out).toBeUndefined();
  });
});

describe("canSendTo", () => {
  it("allows private chats (users)", () => {
    expect(canSendTo(new Api.User({ id: BigInt(1) } as never))).toBe(true);
  });

  it("blocks forbidden peers", () => {
    expect(canSendTo(new Api.ChannelForbidden({ id: BigInt(1) } as never))).toBe(false);
  });

  it("allows broadcast channels only for creators / posting admins", () => {
    expect(canSendTo(new Api.Channel({ broadcast: true } as never))).toBe(false);
    expect(canSendTo(new Api.Channel({ broadcast: true, creator: true } as never))).toBe(true);
    expect(
      canSendTo(
        new Api.Channel({
          broadcast: true,
          adminRights: { postMessages: true },
        } as never)
      )
    ).toBe(true);
  });

  it("respects banned rights in supergroups", () => {
    expect(canSendTo(new Api.Channel({} as never))).toBe(true);
    expect(
      canSendTo(
        new Api.Channel({ defaultBannedRights: { sendMessages: true } } as never)
      )
    ).toBe(false);
  });

  it("blocks basic groups we left or that ban sending", () => {
    expect(canSendTo(new Api.Chat({} as never))).toBe(true);
    expect(canSendTo(new Api.Chat({ left: true } as never))).toBe(false);
  });
});

describe("matchesFolderFlags", () => {
  const filter = (flags: Record<string, boolean>) => flags as unknown as Api.DialogFilter;

  it("matches users by bot / contact / non-contact flags", () => {
    expect(matchesFolderFlags(filter({ bots: true }), new Api.User({ id: BigInt(1), bot: true } as never))).toBe(true);
    expect(matchesFolderFlags(filter({ contacts: true }), new Api.User({ id: BigInt(1), contact: true } as never))).toBe(true);
    expect(matchesFolderFlags(filter({ nonContacts: true }), new Api.User({ id: BigInt(1) } as never))).toBe(true);
    expect(matchesFolderFlags(filter({ contacts: true }), new Api.User({ id: BigInt(1) } as never))).toBe(false);
  });

  it("matches groups and broadcasts", () => {
    expect(matchesFolderFlags(filter({ groups: true }), new Api.Chat({} as never))).toBe(true);
    expect(matchesFolderFlags(filter({ groups: true }), new Api.Channel({} as never))).toBe(true);
    expect(matchesFolderFlags(filter({ broadcasts: true }), new Api.Channel({ broadcast: true } as never))).toBe(true);
    expect(matchesFolderFlags(filter({ groups: true }), new Api.Channel({ broadcast: true } as never))).toBe(false);
  });
});
