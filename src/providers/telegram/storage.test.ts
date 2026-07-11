import { describe, it, expect, beforeEach } from "vitest";
import type * as vscode from "vscode";
import { TelegramStorage } from "./storage";

/** Minimal in-memory stand-in for vscode.SecretStorage. */
class FakeSecrets {
  private readonly map = new Map<string, string>();

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.map.delete(key);
    return Promise.resolve();
  }
}

function makeStorage(): { storage: TelegramStorage; secrets: FakeSecrets } {
  const secrets = new FakeSecrets();
  const storage = new TelegramStorage(secrets as unknown as vscode.SecretStorage);
  return { storage, secrets };
}

describe("TelegramStorage", () => {
  let storage: TelegramStorage;

  beforeEach(() => {
    storage = makeStorage().storage;
  });

  describe("credentials", () => {
    it("returns undefined when nothing is stored", async () => {
      expect(await storage.getCredentials()).toBeUndefined();
    });

    it("stores and reads back credentials, coercing apiId to a number", async () => {
      await storage.setCredentials({ apiId: 12345, apiHash: "abcdef123456" });
      const creds = await storage.getCredentials();
      expect(creds).toEqual({ apiId: 12345, apiHash: "abcdef123456" });
      expect(typeof creds?.apiId).toBe("number");
    });

    it("returns undefined when only one of id/hash is present", async () => {
      const { storage, secrets } = makeStorage();
      await secrets.store("yapper.telegram.apiId", "12345");
      expect(await storage.getCredentials()).toBeUndefined();
    });
  });

  describe("session", () => {
    it("stores and reads back the session string", async () => {
      await storage.setSession("session-blob");
      expect(await storage.getSession()).toBe("session-blob");
    });

    it("clears the session but keeps credentials (logout behaviour)", async () => {
      await storage.setCredentials({ apiId: 1, apiHash: "hash-value" });
      await storage.setSession("session-blob");

      await storage.clearSession();

      expect(await storage.getSession()).toBeUndefined();
      expect(await storage.getCredentials()).toEqual({
        apiId: 1,
        apiHash: "hash-value",
      });
    });
  });
});
