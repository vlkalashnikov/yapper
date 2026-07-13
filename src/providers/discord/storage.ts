import type * as vscode from "vscode";

const KEY_TOKEN = "yapper.discord.token";

/**
 * Persists the Discord user token in VS Code SecretStorage, so it never lands in
 * settings.json or on disk in plain text and survives restarts. A Discord
 * self-bot authenticates with a single token (obtained via QR remote-auth),
 * so this is simpler than Telegram (no api_id/hash) — mirrors TelegramStorage.
 */
export class DiscordStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getToken(): Thenable<string | undefined> {
    return this.secrets.get(KEY_TOKEN);
  }

  setToken(token: string): Thenable<void> {
    return this.secrets.store(KEY_TOKEN, token);
  }

  /** Forget the token (used on logout / when it's invalidated). */
  clearToken(): Thenable<void> {
    return this.secrets.delete(KEY_TOKEN);
  }
}
