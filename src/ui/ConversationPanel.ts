import * as vscode from "vscode";
import * as path from "path";
import { Chat, MediaFile, Message, MessengerProvider } from "../providers/types";
import { parseTelegramLink } from "../util/telegramLinks";

/**
 * The open conversation, rendered as a full-width editor tab (WebviewPanel),
 * styled after Claude Code for VS Code (see ADR-002). A single panel is reused
 * across chats: selecting another chat swaps its content and tab title.
 */
export class ConversationPanel {
  private panel?: vscode.WebviewPanel;
  private currentChat?: Chat;
  /** Monotonic token so a slow getMessages can't overwrite a newer chat switch. */
  private loadSeq = 0;
  /** Cache of "chatId:messageId" -> downloaded media file (uri + kind). */
  private readonly fileCache = new Map<
    string,
    { uri: vscode.Uri; kind: "image" | "video" }
  >();

  private readonly _onDidRead = new vscode.EventEmitter<void>();
  /** Fires after a chat is marked read, so the list can clear its unread dot. */
  readonly onDidRead = this._onDidRead.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly storageUri: vscode.Uri,
    private provider: MessengerProvider
  ) {}

  /** Switch to a different (newly active) provider. The open conversation
   *  belongs to the previous provider, so close it and drop its caches. */
  setProvider(provider: MessengerProvider): void {
    this.provider = provider;
    this.currentChat = undefined;
    this.fileCache.clear();
    this.panel?.dispose();
  }

  /** Open (or reuse) the conversation tab for a chat. */
  async showChat(chat: Chat): Promise<void> {
    this.currentChat = chat;
    const panel = this.ensurePanel();
    // The chat name lives in the webview header; the tab shows the provider.
    panel.title = this.provider.beta
      ? `${this.provider.name} (BETA)`
      : this.provider.name;
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);

    // Switch to the target chat immediately with a spinner — the old chat must
    // not linger while messages load over a slow connection.
    void panel.webview.postMessage({ type: "loading", chat });

    const token = ++this.loadSeq;
    try {
      const [messages, avatar] = await Promise.all([
        this.provider.getMessages(chat.id, chat.topicId),
        this.provider.getAvatar?.(chat.id) ?? Promise.resolve(undefined),
      ]);
      if (token === this.loadSeq) {
        void panel.webview.postMessage({
          type: "load",
          chat,
          messages,
          avatar,
          unreadCount: chat.unreadCount ?? 0,
          canSend: chat.canSend !== false,
          canProfile: !!this.provider.getProfile,
        });
        // Opening the chat marks it read (like Telegram), clearing the dot.
        if ((chat.unreadCount ?? 0) > 0) {
          void this.provider
            .markAsRead?.(chat.id, chat.topicId)
            .then(() => this._onDidRead.fire());
        }
      }
    } catch (err) {
      if (token === this.loadSeq) {
        void panel.webview.postMessage({
          type: "error",
          chat,
          message: (err as Error).message,
        });
      }
    }
  }

  /** The chat currently open in the panel, if any. */
  get activeChat(): Chat | undefined {
    return this.currentChat;
  }

  /** The composer "+" button: pick a file and send it to the open chat. */
  private async attachFile(): Promise<void> {
    if (!this.currentChat) {
      return;
    }
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (uris && uris[0]) {
      void vscode.commands.executeCommand("yapper.shareFile", uris[0]);
    }
  }

  /** Send a code block to the currently-open chat (used by Share commands). */
  async shareCode(text: string, language?: string): Promise<void> {
    await this.sendToActive((chat) => {
      if (!this.provider.sendCode) {
        throw new Error(vscode.l10n.t("sending code is not supported"));
      }
      return this.provider.sendCode(chat.id, text, language, chat.topicId);
    });
  }

  /** Send a plain-text message to the currently-open chat. */
  async shareText(text: string): Promise<void> {
    await this.sendToActive((chat) => {
      if (!this.provider.sendMessage) {
        throw new Error(vscode.l10n.t("sending messages is not supported"));
      }
      return this.provider.sendMessage(chat.id, text, undefined, chat.topicId);
    });
  }

  /** Send a local file as a document to the currently-open chat. */
  async shareFile(filePath: string, filename?: string): Promise<void> {
    await this.sendToActive((chat) => {
      if (!this.provider.sendFile) {
        throw new Error(vscode.l10n.t("sending files is not supported"));
      }
      return this.provider.sendFile(chat.id, filePath, filename, chat.topicId);
    });
  }

  /** Build a message via `make`, send it to the open chat, and show it. */
  private async sendToActive(
    make: (chat: Chat) => Promise<Message>
  ): Promise<void> {
    const chat = this.currentChat;
    if (!chat) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Yapper: open a chat to send to first")
      );
      return;
    }
    try {
      const message = await make(chat);
      this.panel?.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
      void this.panel?.webview.postMessage({ type: "append", message });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Yapper: failed to send — {0}", (err as Error).message)
      );
    }
  }

  /** Whether this chat/topic is open AND the panel is currently visible.
   *  Used to suppress notifications for the chat the user is actively reading. */
  isViewing(chatId: string, topicId?: string): boolean {
    if (!this.panel || !this.panel.visible || !this.currentChat) {
      return false;
    }
    return (
      this.currentChat.id === chatId &&
      (this.currentChat.topicId ?? undefined) === (topicId ?? undefined)
    );
  }

  /** Whether a message belongs to the currently-open chat (and topic). */
  private matchesCurrent(message: Message): boolean {
    if (!this.panel || !this.currentChat || message.chatId !== this.currentChat.id) {
      return false;
    }
    return (message.topicId ?? undefined) === (this.currentChat.topicId ?? undefined);
  }

  /** Append a realtime message, but only if its chat/topic is the open one. */
  appendIfCurrent(message: Message): void {
    if (!this.matchesCurrent(message)) {
      return;
    }
    void this.panel!.webview.postMessage({ type: "append", message });
    // While actively viewing this chat, keep it marked read (no unread dot).
    if (this.panel!.visible && !message.outgoing) {
      void this.provider
        .markAsRead?.(message.chatId, this.currentChat!.topicId)
        .then(() => this._onDidRead.fire());
    }
  }

  /** Replace an edited message in place, if its chat/topic is open. */
  updateIfCurrent(message: Message): void {
    if (!this.matchesCurrent(message)) {
      return;
    }
    void this.panel!.webview.postMessage({ type: "update", message });
  }

  /** Flip outgoing messages up to maxId to "read", if their chat is open. */
  updateReadStatus(chatId: string, maxId: number): void {
    if (!this.panel || this.currentChat?.id !== chatId) {
      return;
    }
    void this.panel.webview.postMessage({ type: "readOutbox", maxId });
  }

  /** Remove deleted messages, if they belong to the open chat. */
  deleteIfCurrent(chatId: string | undefined, ids: string[]): void {
    if (!this.panel || !this.currentChat) {
      return;
    }
    // chatId is unknown for private/basic-group deletes — best-effort by id.
    if (chatId && chatId !== this.currentChat.id) {
      return;
    }
    void this.panel.webview.postMessage({ type: "delete", ids });
  }

  dispose(): void {
    this.panel?.dispose();
    this._onDidRead.dispose();
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) {
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      "yapper.conversation",
      "Yapper",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          this.storageUri,
        ],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");
    panel.webview.html = this.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "send") {
        await this.handleSend(msg.chatId, msg.text, msg.replyToId);
      } else if (msg.type === "retry" && this.currentChat) {
        await this.showChat(this.currentChat);
      } else if (msg.type === "requestMedia") {
        await this.handleMediaRequest(msg.chatId, msg.messageId);
      } else if (msg.type === "copyText" && msg.text) {
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.showInformationMessage(
          vscode.l10n.t("Yapper: invite link copied")
        );
      } else if (msg.type === "openLink" && msg.url) {
        await this.handleLink(msg.url);
      } else if (msg.type === "openFile" && msg.file) {
        await this.openWorkspaceFile(msg.file, msg.line, msg.column);
      } else if (msg.type === "openMedia") {
        await this.openMedia(msg.chatId, msg.messageId);
      } else if (msg.type === "openMediaExternal") {
        this.openExternally(msg.chatId, msg.messageId);
      } else if (msg.type === "loadOlder") {
        await this.handleLoadOlder(msg.chatId, msg.beforeId);
      } else if (msg.type === "loadNewer") {
        await this.handleLoadNewer(msg.chatId, msg.afterId);
      } else if (msg.type === "requestLatest") {
        if (this.currentChat) {
          await this.showChat(this.currentChat);
        }
      } else if (msg.type === "searchMembers") {
        const members =
          (await this.provider.searchMembers?.(msg.chatId, msg.query)) ?? [];
        void this.panel?.webview.postMessage({
          type: "members",
          query: msg.query,
          members,
        });
      } else if (msg.type === "searchChat") {
        this.searchInChat();
      } else if (msg.type === "composerMenu") {
        await this.attachFile();
      } else if (msg.type === "openProfile") {
        await this.handleProfile(msg.chatId);
      } else if (msg.type === "setMuted") {
        await this.provider.setMuted?.(msg.chatId, msg.muted);
        const cur = this.currentChat;
        if (cur && cur.id === msg.chatId) {
          cur.muted = msg.muted;
        }
        this._onDidRead.fire(); // refresh the chat list's mute/notify state
      } else if (msg.type === "loadShared") {
        const messages =
          (await this.provider.getSharedMedia?.(
            msg.chatId,
            msg.kind,
            this.currentChat?.topicId
          )) ?? [];
        void this.panel?.webview.postMessage({
          type: "shared",
          kind: msg.kind,
          messages,
        });
      } else if (msg.type === "requestAround") {
        await this.jumpToMessageInChat(msg.messageId);
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.currentChat = undefined;
    });

    this.panel = panel;
    return panel;
  }

  /** Open a t.me/username link in-app (resolve to a chat, optionally jump to a
   *  message); anything else (invites, external URLs) opens in the browser. */
  private async handleLink(url: string): Promise<void> {
    const target = parseTelegramLink(url);
    if (target && this.provider.resolveChat) {
      const chat = await this.provider.resolveChat(target.username);
      if (chat) {
        await this.showChat(chat);
        if (target.messageId !== undefined) {
          await this.jumpToMessageInChat(String(target.messageId));
        }
        return;
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Load a profile (the open chat by default, or a specific chat/sender id) and
   *  show it in the webview overlay. */
  private async handleProfile(chatId?: string): Promise<void> {
    const targetId = chatId ?? this.currentChat?.id;
    if (!targetId || !this.provider.getProfile) {
      // Provider has no profiles (e.g. WhatsApp MVP) — dismiss the overlay the
      // webview opened optimistically instead of leaving its spinner hanging.
      void this.panel?.webview.postMessage({ type: "profileError" });
      return;
    }
    const profile = await this.provider.getProfile(targetId);
    if (!profile) {
      void this.panel?.webview.postMessage({ type: "profileError" });
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Yapper: profile unavailable")
      );
      return;
    }
    profile.muted =
      targetId === this.currentChat?.id ? this.currentChat?.muted : undefined;
    void this.panel?.webview.postMessage({
      type: "profile",
      profile,
      chatId: targetId,
    });
    // Stream the (slower) big avatar separately so the card doesn't wait for it.
    void this.provider.getProfileAvatar?.(targetId).then((avatar) => {
      if (avatar) {
        void this.panel?.webview.postMessage({
          type: "profileAvatar",
          avatar,
          chatId: targetId,
        });
      }
    });
  }

  /** Search messages in the open chat via a QuickPick; picking one jumps to it. */
  private searchInChat(): void {
    const chat = this.currentChat;
    if (!chat || !this.provider.searchMessages) {
      return;
    }
    const qp = vscode.window.createQuickPick<
      vscode.QuickPickItem & { messageId: string }
    >();
    qp.placeholder = vscode.l10n.t("Search messages in this chat");
    let seq = 0;
    qp.onDidChangeValue(async (value) => {
      const q = value.trim();
      if (q.length < 2) {
        qp.items = [];
        return;
      }
      const token = ++seq;
      qp.busy = true;
      const results = await this.provider.searchMessages!(chat.id, q, chat.topicId);
      if (token !== seq) {
        return; // a newer query superseded this one
      }
      qp.busy = false;
      qp.items = results.map((m) => ({
        label: m.text ? m.text.replace(/\s+/g, " ") : vscode.l10n.t("[media]"),
        description: `${new Date(m.timestamp).toLocaleString(vscode.env.language)} · ${m.author}`,
        messageId: m.id,
        alwaysShow: true,
      }));
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      qp.hide();
      if (sel) {
        void this.jumpToMessageInChat(sel.messageId);
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  /** Open a chat and jump to a specific message (used by global search). */
  async openMessage(chat: Chat, messageId: string): Promise<void> {
    await this.showChat(chat);
    await this.jumpToMessageInChat(messageId);
  }

  /** Load the window around a message and render it, flashing the target — works
   *  even when the message is far outside the currently-loaded history. */
  private async jumpToMessageInChat(messageId: string): Promise<void> {
    const chat = this.currentChat;
    if (!chat || !this.provider.getMessagesAround) {
      return;
    }
    const messages = await this.provider.getMessagesAround(
      chat.id,
      messageId,
      chat.topicId
    );
    void this.panel?.webview.postMessage({
      type: "loadAround",
      messages,
      targetId: messageId,
    });
  }

  private async handleSend(
    chatId: string,
    text: string,
    replyToId?: string
  ): Promise<void> {
    if (!this.provider.sendMessage) {
      return;
    }
    try {
      const message = await this.provider.sendMessage(
        chatId,
        text,
        replyToId,
        this.currentChat?.topicId
      );
      void this.panel?.webview.postMessage({ type: "append", message });
    } catch (err) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Yapper: failed to send message — {0}", (err as Error).message)
      );
      // Return the text so the user doesn't lose it.
      void this.panel?.webview.postMessage({ type: "sendFailed", text });
    }
  }

  /** Open a workspace file referenced from a chat (path:line) at that line. */
  private async openWorkspaceFile(
    file: string,
    line?: number,
    column?: number
  ): Promise<void> {
    const uri = await resolveWorkspaceFile(file);
    if (!uri) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t("Yapper: file not found — {0}", file)
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, Math.max(0, (column ?? 1) - 1));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }

  private async handleMediaRequest(chatId: string, messageId: string): Promise<void> {
    if (!this.provider.getMedia) {
      return;
    }
    const dataUrl = await this.provider.getMedia(chatId, messageId);
    // Always reply so the webview can drop the loading state (dataUrl may be undefined).
    void this.panel?.webview.postMessage({ type: "media", messageId, dataUrl });
  }

  private async handleLoadOlder(chatId: string, beforeId: string): Promise<void> {
    const messages =
      (await this.provider.getMessagesBefore?.(
        chatId,
        beforeId,
        this.currentChat?.topicId
      )) ?? [];
    void this.panel?.webview.postMessage({ type: "prepend", chatId, messages });
  }

  private async handleLoadNewer(chatId: string, afterId: string): Promise<void> {
    const messages =
      (await this.provider.getMessagesAfter?.(
        chatId,
        afterId,
        this.currentChat?.topicId
      )) ?? [];
    void this.panel?.webview.postMessage({ type: "appendNewer", chatId, messages });
  }

  /** Open full-resolution media (image/video) in the in-panel lightbox. */
  private async openMedia(chatId: string, messageId: string): Promise<void> {
    if (!this.provider.getMediaFile) {
      return;
    }
    const key = `${chatId}:${messageId}`;
    let entry = this.fileCache.get(key);
    if (!entry) {
      const file = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Yapper: loading media…"),
        },
        () => this.provider.getMediaFile!(chatId, messageId)
      );
      if (!file) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Yapper: failed to load media")
        );
        return;
      }
      // Plain files are downloaded to a chosen location, not shown in the lightbox.
      if (file.kind === "file") {
        await this.saveFile(file);
        return;
      }
      await vscode.workspace.fs.createDirectory(this.storageUri);
      const uri = vscode.Uri.joinPath(
        this.storageUri,
        `${chatId}_${messageId}.${file.extension}`
      );
      await vscode.workspace.fs.writeFile(uri, file.data);
      entry = { uri, kind: file.kind };
      this.fileCache.set(key, entry);
    }
    const url = this.panel?.webview.asWebviewUri(entry.uri).toString();
    void this.panel?.webview.postMessage({
      type: "lightbox",
      url,
      kind: entry.kind,
      messageId,
    });
  }

  /** Open the cached media in the OS default player (video, for its audio). */
  private openExternally(chatId: string, messageId: string): void {
    const entry = this.fileCache.get(`${chatId}:${messageId}`);
    if (entry) {
      void vscode.env.openExternal(entry.uri);
    }
  }

  /** Save a downloaded file to a user-chosen location, then offer to open it. */
  private async saveFile(file: MediaFile): Promise<void> {
    const dir = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.storageUri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dir, file.filename),
      saveLabel: vscode.l10n.t("Save"),
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, file.data);
    const open = await vscode.window.showInformationMessage(
      vscode.l10n.t("Yapper: file saved — {0}", file.filename),
      vscode.l10n.t("Open")
    );
    if (open) {
      void vscode.env.openExternal(target);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "conversation.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "conversation.js")
    );

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `media-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    // Strings rendered by the webview script (conversation.js) are localized
    // here and injected as window.L10N, since the webview can't call vscode.l10n.
    const l10n = {
      locale: vscode.env.language,
      loading: vscode.l10n.t("Loading messages…"),
      empty: vscode.l10n.t("No messages"),
      loadFailed: vscode.l10n.t("Failed to load the chat"),
      checkConnection: vscode.l10n.t("Check your internet connection"),
      retry: vscode.l10n.t("Retry"),
      today: vscode.l10n.t("Today"),
      yesterday: vscode.l10n.t("Yesterday"),
      unread: vscode.l10n.t("Unread messages ({0})", "{0}"),
      reply: vscode.l10n.t("Reply"),
      replyPrefix: vscode.l10n.t("Reply:"),
      cancel: vscode.l10n.t("Cancel"),
      edited: vscode.l10n.t("edited"),
      goToMessage: vscode.l10n.t("Go to message"),
      message: vscode.l10n.t("Message"),
      you: vscode.l10n.t("You"),
      download: vscode.l10n.t("Download"),
      close: vscode.l10n.t("Close"),
      openWithSound: vscode.l10n.t("Open with sound"),
      searchInChat: vscode.l10n.t("Search in chat"),
      mute: vscode.l10n.t("Mute"),
      unmute: vscode.l10n.t("Unmute"),
      search: vscode.l10n.t("Search"),
      commonChats: vscode.l10n.t("{0} groups in common", "{0}"),
      mediaTab: vscode.l10n.t("Media"),
      filesTab: vscode.l10n.t("Files"),
      nothingHere: vscode.l10n.t("Nothing here yet"),
      copyInvite: vscode.l10n.t("Copy invite link"),
      photo: vscode.l10n.t("🖼 Photo"),
      video: vscode.l10n.t("🎥 Video"),
      gif: vscode.l10n.t("🎬 GIF"),
      sticker: vscode.l10n.t("🖼 Sticker"),
      media: vscode.l10n.t("🖼 Media"),
      image: vscode.l10n.t("🖼 Image"),
      sizeUnits: [
        vscode.l10n.t("B"),
        vscode.l10n.t("KB"),
        vscode.l10n.t("MB"),
        vscode.l10n.t("GB"),
      ],
    };

    return /* html */ `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Yapper</title>
</head>
<body>
  <div id="header">
    <span id="header-avatar"></span><span id="title"></span>
    <button id="header-search" title="${vscode.l10n.t("Search in chat")}">🔍</button>
  </div>
  <div id="messages"><div id="older-loader" class="hidden"><div class="spinner"></div></div><div id="thread"></div></div>
  <button id="scroll-down" class="hidden" title="${vscode.l10n.t("Scroll to bottom")}">↓</button>
  <div id="composer">
    <div id="mention-popup" class="hidden"></div>
    <div class="composer-box">
      <div id="reply-bar" class="hidden"></div>
      <textarea id="input" rows="1" placeholder="${vscode.l10n.t("Message...")}"></textarea>
      <div class="composer-toolbar">
        <div class="left">
          <button class="icon-btn" id="attach" title="${vscode.l10n.t("Attach a file")}">+</button>
        </div>
        <button class="send-btn" id="send" title="${vscode.l10n.t("Send")}" disabled>↑</button>
      </div>
    </div>
  </div>
  <div id="readonly" class="hidden">${vscode.l10n.t("🔒 You can't send messages here")}</div>
  <div id="lightbox" class="hidden">
    <button class="lb-close" title="${vscode.l10n.t("Close")}">✕</button>
    <div class="lb-stage"></div>
  </div>
  <div id="profile" class="hidden">
    <button class="pf-close" title="${vscode.l10n.t("Close")}">✕</button>
    <div class="pf-card"></div>
  </div>
  <script nonce="${nonce}">window.L10N = ${JSON.stringify(l10n)};
    window.YAPPER = { pageSize: ${this.provider.historyPageSize ?? 50} };</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Resolve a file reference from a chat to a workspace file URI, or undefined.
 *  Tries the path under each workspace folder (stripping git a/ b/ prefixes),
 *  then falls back to searching the workspace by path suffix. */
async function resolveWorkspaceFile(file: string): Promise<vscode.Uri | undefined> {
  const clean = file.replace(/^\.\//, "");
  const stripped = clean.replace(/^[ab]\//, ""); // git diff a/… b/… prefixes
  const folders = vscode.workspace.workspaceFolders ?? [];

  const candidates: vscode.Uri[] = [];
  if (path.isAbsolute(clean)) {
    candidates.push(vscode.Uri.file(clean));
  } else {
    for (const f of folders) {
      candidates.push(vscode.Uri.joinPath(f.uri, clean));
      if (stripped !== clean) {
        candidates.push(vscode.Uri.joinPath(f.uri, stripped));
      }
    }
  }

  for (const uri of candidates) {
    try {
      if ((await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File) {
        return uri;
      }
    } catch {
      // not at this candidate — try the next
    }
  }

  const found = await vscode.workspace.findFiles(
    `**/${stripped}`,
    "**/node_modules/**",
    1
  );
  return found[0];
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
