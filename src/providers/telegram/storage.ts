import * as vscode from "vscode";

const KEY_SESSION = "yapper.telegram.session";
const KEY_API_ID = "yapper.telegram.apiId";
const KEY_API_HASH = "yapper.telegram.apiHash";

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

/**
 * Persists Telegram credentials and the GramJS session string in VS Code
 * SecretStorage, so nothing sensitive ever lands in settings.json or on disk
 * in plain text. The session survives VS Code restarts (MVP requirement).
 */
export class TelegramStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getSession(): Thenable<string | undefined> {
    return this.secrets.get(KEY_SESSION);
  }

  setSession(session: string): Thenable<void> {
    return this.secrets.store(KEY_SESSION, session);
  }

  async getCredentials(): Promise<TelegramCredentials | undefined> {
    const [id, hash] = await Promise.all([
      this.secrets.get(KEY_API_ID),
      this.secrets.get(KEY_API_HASH),
    ]);
    if (!id || !hash) {
      return undefined;
    }
    return { apiId: Number(id), apiHash: hash };
  }

  async setCredentials(creds: TelegramCredentials): Promise<void> {
    await this.secrets.store(KEY_API_ID, String(creds.apiId));
    await this.secrets.store(KEY_API_HASH, creds.apiHash);
  }

  /** Forget the session (used on logout), keeping API credentials for re-login. */
  clearSession(): Thenable<void> {
    return this.secrets.delete(KEY_SESSION);
  }
}
