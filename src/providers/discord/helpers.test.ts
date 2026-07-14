import { describe, it, expect } from "vitest";
import {
  attachmentInfo,
  extFromMime,
  guildFolderId,
  toMessage,
  muteActive,
  channelMuted,
  DiscordMessageLike,
} from "./helpers";

const base: DiscordMessageLike = {
  id: "m1",
  channelId: "c1",
  content: "hi",
  author: { id: "u1", username: "alice", globalName: "Alice" },
  createdTimestamp: 1000,
};

describe("attachmentInfo", () => {
  it("classifies images by content type", () => {
    expect(attachmentInfo({ contentType: "image/png", name: "a.png" })).toEqual({
      hasImage: true,
      mediaKind: "photo",
    });
    expect(attachmentInfo({ contentType: "image/gif", name: "a.gif" })).toEqual({
      hasImage: true,
      mediaKind: "gif",
    });
  });

  it("classifies video by content type", () => {
    expect(attachmentInfo({ contentType: "video/mp4", name: "v.mp4" })).toEqual({
      hasImage: true,
      mediaKind: "video",
    });
  });

  it("falls back to the extension when content type is missing", () => {
    expect(attachmentInfo({ contentType: null, name: "pic.JPEG" })).toEqual({
      hasImage: true,
      mediaKind: "photo",
    });
    expect(attachmentInfo({ name: "clip.mov" })).toEqual({
      hasImage: true,
      mediaKind: "video",
    });
  });

  it("treats anything else as a downloadable file", () => {
    expect(
      attachmentInfo({ contentType: "application/pdf", name: "doc.pdf", size: 1234 })
    ).toEqual({ file: { name: "doc.pdf", size: 1234 } });
    expect(attachmentInfo({ name: "archive.zip", size: 9 })).toEqual({
      file: { name: "archive.zip", size: 9 },
    });
  });

  it("names an unnamed attachment 'file'", () => {
    expect(attachmentInfo({ contentType: "application/octet-stream" })).toEqual({
      file: { name: "file", size: undefined },
    });
  });
});

describe("extFromMime", () => {
  it("maps known mime types", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("VIDEO/MP4")).toBe("mp4");
  });
  it("falls back to bin for unknown/empty", () => {
    expect(extFromMime("application/x-weird")).toBe("bin");
    expect(extFromMime(undefined)).toBe("bin");
  });
});

describe("toMessage", () => {
  it("maps text with markdown into text + entities", () => {
    const msg = toMessage({ ...base, content: "**bold**" });
    expect(msg).toMatchObject({
      id: "m1",
      chatId: "c1",
      author: "Alice",
      senderId: "u1",
      text: "bold",
      timestamp: 1000,
      outgoing: false,
      entities: [{ type: "bold", offset: 0, length: 4 }],
    });
  });

  it("marks a message from the current user as outgoing", () => {
    expect(toMessage(base, "u1").outgoing).toBe(true);
    expect(toMessage(base, "other").outgoing).toBe(false);
  });

  it("prefers the server nickname for the author", () => {
    expect(
      toMessage({ ...base, member: { displayName: "Ali (mod)" } }).author
    ).toBe("Ali (mod)");
  });

  it("resolves mentions via the message's mention collections", () => {
    const msg = toMessage({
      ...base,
      content: "hey <@222>",
      mentions: {
        users: { get: (id) => (id === "222" ? { id: "222", username: "bob" } : undefined) },
      },
    });
    expect(msg.text).toBe("hey @bob");
    expect(msg.entities).toEqual([{ type: "mention", offset: 4, length: 4 }]);
  });

  it("reads a forwarded message's body from its snapshot (not `content`)", () => {
    const msg = toMessage({
      ...base,
      content: "",
      reference: { messageId: "m0", type: "FORWARD" },
      messageSnapshots: {
        first: () => ({ content: "**forwarded**" }),
      },
    });
    expect(msg.text).toBe("forwarded");
    expect(msg.entities).toEqual([{ type: "bold", offset: 0, length: 9 }]);
    // A forward is not a reply — no reply quote.
    expect(msg.reply).toBeUndefined();
  });

  it("falls back to embed text when content is empty (bot messages)", () => {
    const msg = toMessage({
      ...base,
      content: "",
      embeds: [{ title: "Release v2", description: "**shipped** it" }],
    });
    expect(msg.text).toBe("Release v2\n\nshipped it");
    expect(msg.entities).toEqual([{ type: "bold", offset: 12, length: 7 }]);
  });

  it("maps attachment-only messages to media fields", () => {
    const img = toMessage({
      ...base,
      content: "",
      attachments: { size: 1, first: () => ({ contentType: "image/png", name: "a.png" }) },
    });
    expect(img).toMatchObject({ text: "", hasImage: true, mediaKind: "photo" });
    const doc = toMessage({
      ...base,
      content: "",
      attachments: { size: 1, first: () => ({ contentType: "application/pdf", name: "r.pdf", size: 9 }) },
    });
    expect(doc.file).toEqual({ name: "r.pdf", size: 9 });
  });

  it("keeps a caption alongside an image attachment", () => {
    const msg = toMessage({
      ...base,
      content: "nice",
      attachments: { size: 1, first: () => ({ contentType: "image/png", name: "a.png" }) },
    });
    expect(msg.text).toBe("nice");
    expect(msg.hasImage).toBe(true);
  });

  it("extracts text from a Components V2 tree (Container → Section → TextDisplay)", () => {
    const msg = toMessage({
      ...base,
      content: "",
      components: [
        {
          components: [
            { components: [{ content: "hello **world**" }] },
            { components: [{ content: "second block" }] },
          ],
        },
      ],
    });
    expect(msg.text).toBe("hello world\n\nsecond block");
    expect(msg.entities).toEqual([{ type: "bold", offset: 6, length: 5 }]);
  });

  it("labels system messages (join/boost) that have no content", () => {
    expect(
      toMessage({ ...base, content: "", type: "GUILD_MEMBER_JOIN" }).text
    ).toBe("joined the server");
  });

  it("prefers real content over embeds when both exist", () => {
    const msg = toMessage({
      ...base,
      content: "look",
      embeds: [{ description: "embed body" }],
    });
    expect(msg.text).toBe("look");
  });

  it("flags edited messages and carries a reply reference", () => {
    const msg = toMessage({
      ...base,
      editedTimestamp: 2000,
      reference: { messageId: "m0" },
    });
    expect(msg.edited).toBe(true);
    expect(msg.reply).toEqual({ id: "m0", author: "", text: "" });
  });
});

describe("guildFolderId", () => {
  it("assigns stable ids starting at 2 and reuses them", () => {
    const seen = new Map<string, number>();
    expect(guildFolderId("111", seen)).toBe(2);
    expect(guildFolderId("222", seen)).toBe(3);
    expect(guildFolderId("111", seen)).toBe(2); // stable
    expect(guildFolderId("333", seen)).toBe(4);
  });
});

describe("muteActive", () => {
  const now = 1_000_000;
  it("is false when not muted", () => {
    expect(muteActive(false, null, now)).toBe(false);
    expect(muteActive(undefined, now + 1000, now)).toBe(false);
  });
  it("treats no end time (or NaN) as a permanent mute", () => {
    expect(muteActive(true, null, now)).toBe(true);
    expect(muteActive(true, undefined, now)).toBe(true);
    expect(muteActive(true, NaN, now)).toBe(true);
  });
  it("honors a timed mute's end time", () => {
    expect(muteActive(true, now + 1000, now)).toBe(true); // future → muted
    expect(muteActive(true, now - 1000, now)).toBe(false); // expired → not muted
  });
});

describe("channelMuted", () => {
  const now = 1_000_000;
  it("is false without settings", () => {
    expect(channelMuted(undefined, "c1", now)).toBe(false);
    expect(channelMuted({}, "c1", now)).toBe(false);
  });
  it("mutes a channel by its own override", () => {
    const s = { channelOverrides: [{ channel_id: "c1", muted: true }] };
    expect(channelMuted(s, "c1", now)).toBe(true);
    expect(channelMuted(s, "c2", now)).toBe(false); // other channel unaffected
  });
  it("honors a timed channel override", () => {
    const future = new Date(now + 5000).toISOString();
    const past = new Date(now - 5000).toISOString();
    expect(
      channelMuted(
        { channelOverrides: [{ channel_id: "c1", muted: true, mute_config: { end_time: future } }] },
        "c1",
        now
      )
    ).toBe(true);
    expect(
      channelMuted(
        { channelOverrides: [{ channel_id: "c1", muted: true, mute_config: { end_time: past } }] },
        "c1",
        now
      )
    ).toBe(false);
  });
  it("mutes every channel when the whole guild is muted", () => {
    expect(channelMuted({ muted: true }, "any", now)).toBe(true);
  });
  it("respects a guild mute's end time", () => {
    expect(
      channelMuted({ muted: true, muteConfig: { endTime: new Date(now - 1) } }, "c1", now)
    ).toBe(false);
    expect(
      channelMuted({ muted: true, muteConfig: { endTime: new Date(now + 1) } }, "c1", now)
    ).toBe(true);
  });
});
