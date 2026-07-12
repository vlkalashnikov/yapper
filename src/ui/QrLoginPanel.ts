import * as vscode from "vscode";
import * as QRCode from "qrcode";
import { AuthCancelled } from "../util/AuthCancelled";

/** Provider-supplied copy for the QR sign-in panel. `steps` may contain simple
 *  inline HTML (e.g. <b>…</b>); it is our own localized text, not user input. */
export interface QrLoginText {
  /** Panel/tab title. */
  title: string;
  /** Heading shown above the QR. */
  heading: string;
  /** Ordered instruction steps. */
  steps: string[];
  /** Footer hint. */
  hint: string;
}

/**
 * A provider-neutral webview panel that displays a QR login code. The provider
 * refreshes the token periodically, so render() is called multiple times; the
 * panel is reused and only its QR image is swapped. Closing the panel cancels
 * login (the onCancel promise rejects with AuthCancelled).
 */
export class QrLoginPanel {
  private panel?: vscode.WebviewPanel;
  private settled = false;
  private rejectCancel!: (err: Error) => void;
  /** Rejects with AuthCancelled if the user closes the panel before login finishes. */
  readonly onCancel: Promise<never>;

  constructor(private readonly text: QrLoginText) {
    this.onCancel = new Promise<never>((_, reject) => {
      this.rejectCancel = reject;
    });
  }

  /** Render (or re-render) a QR encoding the given string (login URL / token). */
  async render(data: string): Promise<void> {
    const svg = await QRCode.toString(data, {
      type: "svg",
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "yapper.qrLogin",
        this.text.title,
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
    const steps = this.text.steps.map((s) => `<li>${s}</li>`).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="${vscode.env.language}">
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
  <h2>${this.text.heading}</h2>
  <div class="qr">${svg}</div>
  <ol>${steps}</ol>
  <div class="hint">${this.text.hint}</div>
</body>
</html>`;
  }
}
