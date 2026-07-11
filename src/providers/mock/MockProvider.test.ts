import { describe, it, expect, beforeEach } from "vitest";
import { MockProvider } from "./MockProvider";

describe("MockProvider", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("identifies itself as the mock provider", () => {
    expect(provider.id).toBe("mock");
    expect(provider.name).toBe("Mock");
  });

  it("returns the seeded chats", async () => {
    const chats = await provider.getChats();
    expect(chats.map((c) => c.id)).toEqual(["backend", "general", "qa", "family"]);
    expect(chats.find((c) => c.id === "qa")?.unreadCount).toBe(5);
  });

  it("returns the messages of a known chat", async () => {
    const messages = await provider.getMessages("backend");
    expect(messages).toHaveLength(3);
    expect(messages[0].author).toBe("Иван");
    expect(messages.every((m) => m.chatId === "backend")).toBe(true);
  });

  it("returns an empty history for an unknown chat", async () => {
    expect(await provider.getMessages("does-not-exist")).toEqual([]);
  });

  describe("sendMessage", () => {
    it("returns an outgoing message with the sent text", async () => {
      const sent = await provider.sendMessage("general", "hi");
      expect(sent.outgoing).toBe(true);
      expect(sent.author).toBe("Я");
      expect(sent.text).toBe("hi");
      expect(sent.chatId).toBe("general");
      expect(sent.timestamp).toBeGreaterThan(0);
    });

    it("appends the message to the chat history", async () => {
      const before = (await provider.getMessages("general")).length;
      await provider.sendMessage("general", "hi");
      const after = await provider.getMessages("general");
      expect(after).toHaveLength(before + 1);
      expect(after[after.length - 1].text).toBe("hi");
    });

    it("updates the chat's last-message preview", async () => {
      await provider.sendMessage("qa", "новое сообщение");
      const chat = (await provider.getChats()).find((c) => c.id === "qa");
      expect(chat?.lastMessage).toBe("новое сообщение");
    });

    it("starts a history for a chat that had none", async () => {
      const sent = await provider.sendMessage("brand-new", "first");
      expect(await provider.getMessages("brand-new")).toEqual([sent]);
    });
  });
});
