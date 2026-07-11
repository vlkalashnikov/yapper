import * as vscode from "vscode";
import { TelegramCredentials } from "./storage";

/** Raised when the user dismisses an auth input box. */
export class AuthCancelled extends Error {
  constructor() {
    super(vscode.l10n.t("Authorization cancelled"));
    this.name = "AuthCancelled";
  }
}

/**
 * Ask for the api_id / api_hash pair (from my.telegram.org).
 * Returns undefined if the user cancels.
 */
export async function promptCredentials(
  existing?: TelegramCredentials
): Promise<TelegramCredentials | undefined> {
  const apiIdStr = await vscode.window.showInputBox({
    title: "Telegram API ID",
    prompt: vscode.l10n.t("Get it at my.telegram.org → API development tools"),
    value: existing ? String(existing.apiId) : "",
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^\d+$/.test(v.trim()) ? undefined : vscode.l10n.t("API ID must be a number"),
  });
  if (apiIdStr === undefined) {
    return undefined;
  }

  const apiHash = await vscode.window.showInputBox({
    title: "Telegram API Hash",
    prompt: vscode.l10n.t("From the same section of my.telegram.org"),
    value: existing?.apiHash ?? "",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.trim().length >= 8 ? undefined : vscode.l10n.t("This doesn't look like a valid hash"),
  });
  if (apiHash === undefined) {
    return undefined;
  }

  return { apiId: Number(apiIdStr.trim()), apiHash: apiHash.trim() };
}

/** Prompt for the 2FA cloud password. Invoked by QR login when 2FA is enabled. */
export async function promptPassword(hint?: string): Promise<string> {
  const value = await vscode.window.showInputBox({
    title: vscode.l10n.t("Two-factor authentication password"),
    prompt: hint
      ? vscode.l10n.t("Hint: {0}", hint)
      : vscode.l10n.t("Telegram cloud password (2FA)"),
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    throw new AuthCancelled();
  }
  return value.trim();
}
