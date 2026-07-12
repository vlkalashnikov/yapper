import * as vscode from "vscode";

/** Raised when the user dismisses an auth prompt or closes the QR login panel.
 *  Shared across providers (Telegram, WhatsApp, …). */
export class AuthCancelled extends Error {
  constructor() {
    super(vscode.l10n.t("Authorization cancelled"));
    this.name = "AuthCancelled";
  }
}
