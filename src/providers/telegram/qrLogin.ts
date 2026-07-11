import * as vscode from "vscode";
import * as QRCode from "qrcode";
import { AuthCancelled } from "./auth";

/**
 * A webview panel that displays the Telegram QR login code. GramJS refreshes
 * the token periodically, so render() is called multiple times; the panel is
 * reused and only its QR image is swapped. Closing the panel cancels login.
 */
export class QrLoginPanel {
  private panel?: vscode.WebviewPanel;
  private settled = false;
  private rejectCancel!: (err: Error) => void;
  /** Rejects with AuthCancelled if the user closes the panel before login finishes. */
  readonly onCancel: Promise<never>;

  constructor() {
    this.onCancel = new Promise<never>((_, reject) => {
      this.rejectCancel = reject;
    });
  }

  /** Render (or re-render) the QR for the given tg://login URL. */
  async render(loginUrl: string): Promise<void> {
    const svg = await QRCode.toString(loginUrl, {
      type: "svg",
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "yapper.qrLogin",
        vscode.l10n.t("Sign in to Telegram"),
        vscode.ViewColumn.Active,
        { enableScripts: false, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        if (!this.settled) {
          this.settled = true;
          this.rejectCancel(new AuthCancelled());
        }
      });
    }
    this.panel.webview.html = this.html(svg);
  }

  /** Close the panel after successful login (does not trigger cancellation). */
  close(): void {
    this.settled = true;
    this.panel?.dispose();
    this.panel = undefined;
  }

  private html(svg: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
      padding: 40px 20px;
    }
    h2 { margin: 0; font-weight: 600; }
    .qr {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      width: 260px;
      height: 260px;
    }
    .qr svg { width: 100%; height: 100%; display: block; }
    ol {
      max-width: 320px;
      line-height: 1.6;
      color: var(--vscode-descriptionForeground);
      padding-left: 20px;
    }
    .hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>${vscode.l10n.t("Sign in to Telegram with a QR code")}</h2>
  <div class="qr">${svg}</div>
  <ol>
    <li>${vscode.l10n.t("Open Telegram on your phone")}</li>
    <li>${vscode.l10n.t("Settings → Devices → {0}", "<b>" + vscode.l10n.t("Link Desktop Device") + "</b>")}</li>
    <li>${vscode.l10n.t("Point the camera at this QR code")}</li>
  </ol>
  <div class="hint">${vscode.l10n.t("The code refreshes automatically. Keep this window open until you sign in.")}</div>
</body>
</html>`;
  }
}
