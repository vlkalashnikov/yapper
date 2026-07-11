import { Chat, Message, MessengerProvider } from "../types";

/**
 * In-memory provider with fake data. Used for v0.1 so the UI can be built
 * and demoed before any real messenger integration exists.
 */
export class MockProvider implements MessengerProvider {
  readonly id = "mock";
  readonly name = "Mock";

  private readonly chats: Chat[] = [
    { id: "backend", title: "Backend", lastMessage: "Деплой прошёл успешно", unreadCount: 2 },
    { id: "general", title: "General", lastMessage: "Всем привет 👋", unreadCount: 0 },
    { id: "qa", title: "QA", lastMessage: "Нашёл баг в логине", unreadCount: 5 },
    { id: "family", title: "Family", lastMessage: "Ужин в 8?", unreadCount: 1 },
  ];

  private readonly messages: Record<string, Message[]> = {
    backend: [
      { id: "b1", chatId: "backend", author: "Иван", text: "Привет, посмотри PR #42", timestamp: Date.now() - 3600_000, outgoing: false },
      { id: "b2", chatId: "backend", author: "Я", text: "Ок, гляну после обеда", timestamp: Date.now() - 3400_000, outgoing: true },
      { id: "b3", chatId: "backend", author: "Иван", text: "Деплой прошёл успешно", timestamp: Date.now() - 600_000, outgoing: false },
    ],
    general: [
      { id: "g1", chatId: "general", author: "Аня", text: "Всем привет 👋", timestamp: Date.now() - 7200_000, outgoing: false },
    ],
    qa: [
      { id: "q1", chatId: "qa", author: "Олег", text: "Нашёл баг в логине", timestamp: Date.now() - 1200_000, outgoing: false },
    ],
    family: [
      { id: "f1", chatId: "family", author: "Мама", text: "Ужин в 8?", timestamp: Date.now() - 300_000, outgoing: false },
    ],
  };

  async getChats(): Promise<Chat[]> {
    return this.chats;
  }

  async getMessages(chatId: string): Promise<Message[]> {
    return this.messages[chatId] ?? [];
  }

  async sendMessage(chatId: string, text: string): Promise<Message> {
    const message: Message = {
      id: `${chatId}-${Date.now()}`,
      chatId,
      author: "Я",
      text,
      timestamp: Date.now(),
      outgoing: true,
    };
    (this.messages[chatId] ??= []).push(message);

    const chat = this.chats.find((c) => c.id === chatId);
    if (chat) {
      chat.lastMessage = text;
    }
    return message;
  }
}
