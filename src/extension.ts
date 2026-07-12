import * as vscode from "vscode";
import * as path from "path";
import { TelegramProvider } from "./providers/telegram/TelegramProvider";
import { TelegramStorage } from "./providers/telegram/storage";
import { WhatsAppProvider } from "./providers/whatsapp/WhatsAppProvider";
import { ChatTreeProvider } from "./ui/ChatTreeProvider";
import { ConversationPanel } from "./ui/ConversationPanel";
import { Chat, GlobalHit, Message, Messenger } from "./providers/types";

// globalState key remembering which provider was active last session.
const ACTIVE_PROVIDER_KEY = "yapper.activeProvider";

export function activate(context: vscode.ExtensionContext): void {
  const storage = new TelegramStorage(context.secrets);
  const telegram = new TelegramProvider(storage);
  const whatsapp = new WhatsAppProvider(
    vscode.Uri.joinPath(context.globalStorageUri, "whatsapp-auth").fsPath
  );
  // The registry of available messengers.
  const providers: Messenger[] = [telegram, whatsapp];

  // Restore the last active provider (default: the first available).
  const savedId = context.globalState.get<string>(ACTIVE_PROVIDER_KEY);
  let active: Messenger =
    providers.find((p) => p.id === savedId) ?? providers[0];

  const chatTree = new ChatTreeProvider(active);
  const conversation = new ConversationPanel(
    context.extensionUri,
    context.globalStorageUri,
    active
  );

  const treeView = vscode.window.createTreeView("yapper.chats", {
    treeDataProvider: chatTree,
  });

  // A single context key drives command/menu visibility for the active provider.
  const setConnected = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "yapper.connected",
      active.connected
    );
    chatTree.refresh();
  };
  setConnected();

  // Make `next` the active provider: re-point the UI and remember the choice.
  const switchTo = (next: Messenger): void => {
    if (next === active) {
      return;
    }
    active = next;
    void context.globalState.update(ACTIVE_PROVIDER_KEY, active.id);
    chatTree.setProvider(active);
    conversation.setProvider(active);
    setConnected();
  };

  // Show a toast for an incoming message unless the user is reading that chat.
  const maybeNotify = (message: Message): void => {
    if (message.outgoing) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration("yapper");
    if (!cfg.get<boolean>("notifications.enabled", true)) {
      return;
    }
    if (conversation.isViewing(message.chatId, message.topicId)) {
      return;
    }
    if (active.isChatMuted?.(message.chatId)) {
      return;
    }
    const chat = chatTree.getChatById(message.chatId);
    const who =
      chat && chat.title !== message.author
        ? `${chat.title} · ${message.author}`
        : message.author;
    const body = cfg.get<boolean>("notifications.showPreview", true)
      ? `${who}: ${messagePreview(message)}`
      : vscode.l10n.t("{0}: new message", who);
    const open = vscode.l10n.t("Open");
    void vscode.window.showInformationMessage(body, open).then((pick) => {
      if (pick === open && chat) {
        void conversation.showChat(chat);
      }
    });
  };

  // Wire every provider's realtime events. Only the active provider drives the
  // UI, so each handler ignores events coming from an inactive provider.
  for (const p of providers) {
    const subs: vscode.Disposable[] = [
      p.onConnectionChange(() => {
        if (p === active) {
          setConnected();
        }
      }),
      p.onMessage((message) => {
        if (p !== active) {
          return;
        }
        chatTree.refresh();
        conversation.appendIfCurrent(message);
        maybeNotify(message);
      }),
    ];
    const edited = p.onMessageEdited?.((message) => {
      if (p === active) {
        chatTree.refresh();
        conversation.updateIfCurrent(message);
      }
    });
    if (edited) {
      subs.push(edited);
    }
    const deleted = p.onMessagesDeleted?.(({ chatId, ids }) => {
      if (p === active) {
        chatTree.refresh();
        conversation.deleteIfCurrent(chatId, ids);
      }
    });
    if (deleted) {
      subs.push(deleted);
    }
    const readOutbox = p.onReadOutbox?.(({ chatId, maxId }) => {
      if (p === active) {
        conversation.updateReadStatus(chatId, maxId);
      }
    });
    if (readOutbox) {
      subs.push(readOutbox);
    }
    context.subscriptions.push(...subs, { dispose: () => p.dispose() });
  }

  context.subscriptions.push(
    treeView,

    chatTree.onDidChangeBadge((count) => {
      treeView.badge =
        count > 0
          ? { value: count, tooltip: vscode.l10n.t("Unread: {0}", count) }
          : undefined;
    }),

    conversation.onDidRead(() => chatTree.refresh()),

    vscode.commands.registerCommand("yapper.refreshChats", () => {
      chatTree.refresh();
    }),

    vscode.commands.registerCommand("yapper.searchGlobal", () => {
      const p = active;
      if (!p.connected) {
        vscode.window.showWarningMessage(vscode.l10n.t("Yapper: sign in first"));
        return;
      }
      if (!p.searchGlobal) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Yapper: not supported by {0}", p.name)
        );
        return;
      }
      const qp = vscode.window.createQuickPick<
        vscode.QuickPickItem & { hit: GlobalHit }
      >();
      qp.placeholder = vscode.l10n.t("Search all messages");
      let seq = 0;
      qp.onDidChangeValue(async (value) => {
        const q = value.trim();
        if (q.length < 2) {
          qp.items = [];
          return;
        }
        const token = ++seq;
        qp.busy = true;
        const hits = (await p.searchGlobal!(q)) ?? [];
        if (token !== seq) {
          return;
        }
        qp.busy = false;
        qp.items = hits.map((h) => ({
          label: h.chatTitle,
          description: h.snippet,
          detail: new Date(h.timestamp).toLocaleString(vscode.env.language),
          hit: h,
          alwaysShow: true,
        }));
      });
      qp.onDidAccept(async () => {
        const sel = qp.selectedItems[0];
        qp.hide();
        if (sel) {
          const chat = await p.resolveChat?.(sel.hit.chatId);
          if (chat) {
            await conversation.openMessage(chat, sel.hit.messageId);
          }
        }
      });
      qp.onDidHide(() => qp.dispose());
      qp.show();
    }),

    vscode.commands.registerCommand("yapper.searchChats", async () => {
      const p = active;
      if (!p.connected) {
        vscode.window.showWarningMessage(vscode.l10n.t("Yapper: sign in first"));
        return;
      }
      const chats = await p.getChats();
      const items = chats.map((chat) => ({
        label: `${chat.unreadCount ? "$(circle-filled) " : ""}${chat.title}`,
        description: chat.lastMessage,
        chat,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: vscode.l10n.t("Search chats"),
      });
      if (pick) {
        void conversation.showChat(pick.chat);
      }
    }),

    vscode.commands.registerCommand("yapper.openChat", (chat: Chat) => {
      void conversation.showChat(chat);
    }),

    vscode.commands.registerCommand("yapper.login", async () => {
      const p = active;
      try {
        await p.login();
        if (p.connected) {
          vscode.window.showInformationMessage(
            vscode.l10n.t("Yapper: signed in to {0}", p.name)
          );
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t("Yapper: sign-in failed — {0}", (err as Error).message)
        );
      }
    }),

    vscode.commands.registerCommand("yapper.switchMessenger", async () => {
      const pick = await vscode.window.showQuickPick(
        providers.map((p) => ({
          label: `${p === active ? "$(check) " : ""}${p.name}`,
          description: p.connected
            ? vscode.l10n.t("connected")
            : vscode.l10n.t("not signed in"),
          provider: p,
        })),
        { placeHolder: vscode.l10n.t("Switch messenger") }
      );
      if (pick) {
        switchTo(pick.provider);
      }
    }),

    vscode.commands.registerCommand("yapper.shareSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(vscode.l10n.t("Yapper: no active editor"));
        return;
      }
      const sel = editor.selection;
      const text = sel.isEmpty
        ? editor.document.getText()
        : editor.document.getText(sel);
      if (!text.trim()) {
        vscode.window.showWarningMessage(vscode.l10n.t("Yapper: nothing to send"));
        return;
      }
      await conversation.shareCode(capCode(text), editor.document.languageId);
    }),

    vscode.commands.registerCommand("yapper.shareLocation", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage(vscode.l10n.t("Yapper: no active editor"));
        return;
      }
      // Workspace-relative path + cursor line, as a clickable "path:line" ref.
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      const line = editor.selection.active.line + 1;
      await conversation.shareText(`${rel}:${line}`);
    }),

    vscode.commands.registerCommand(
      "yapper.shareFile",
      async (arg?: vscode.Uri) => {
        // Invoked from the explorer (arg = file) or for the active editor file.
        const uri =
          arg instanceof vscode.Uri
            ? arg
            : vscode.window.activeTextEditor?.document.uri;
        if (!uri || uri.scheme !== "file") {
          vscode.window.showWarningMessage(
            vscode.l10n.t("Yapper: open a saved file")
          );
          return;
        }
        await conversation.shareFile(uri.fsPath, path.basename(uri.fsPath));
      }
    ),

    vscode.commands.registerCommand("yapper.shareDiff", async () => {
      const diff = await getWorkingDiff();
      if (diff === undefined) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Yapper: no Git repository found")
        );
        return;
      }
      if (!diff.trim()) {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Yapper: no uncommitted changes")
        );
        return;
      }
      await conversation.shareCode(capCode(diff), "diff");
    }),

    vscode.commands.registerCommand("yapper.shareCommit", async () => {
      const repo = await getRepo();
      if (!repo) {
        vscode.window.showWarningMessage(
          vscode.l10n.t("Yapper: no Git repository found")
        );
        return;
      }
      let commit: GitCommit;
      try {
        commit = await repo.getCommit("HEAD");
      } catch {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Yapper: the repository has no commits")
        );
        return;
      }
      await conversation.shareText(formatCommit(commit));
    }),

    vscode.commands.registerCommand("yapper.logout", async () => {
      const p = active;
      await p.logout();
      vscode.window.showInformationMessage(
        vscode.l10n.t("Yapper: signed out of {0}", p.name)
      );
    })
  );

  // Reconnect each provider's saved session in the background so chats appear
  // on startup (whichever is active drives the UI).
  for (const p of providers) {
    p.init().catch((err) => {
      console.error(`[Yapper] ${p.name} init failed:`, err);
    });
  }

  console.log("Yapper activated");
}

export function deactivate(): void {
  // Provider disposal is handled via context.subscriptions.
}

// Minimal shape of the built-in Git extension API we use.
interface GitCommit {
  hash: string;
  message: string;
  authorName?: string;
  authorDate?: Date;
}
interface GitRepository {
  diff(cached?: boolean): Promise<string>;
  getCommit(ref: string): Promise<GitCommit>;
}
interface GitAPI {
  repositories: GitRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

/** The first Git repository open in the window, or undefined if none. */
async function getRepo(): Promise<GitRepository | undefined> {
  const ext = vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
  if (!ext) {
    return undefined;
  }
  const api = (await ext.activate()).getAPI(1);
  return api.repositories[0];
}

/** Combined staged + unstaged working-tree diff, or undefined when there is
 *  no Git repository available. */
async function getWorkingDiff(): Promise<string | undefined> {
  const repo = await getRepo();
  if (!repo) {
    return undefined;
  }
  const [staged, unstaged] = await Promise.all([repo.diff(true), repo.diff(false)]);
  return [staged, unstaged].filter((s) => s && s.trim()).join("\n");
}

/** Format a commit as a shareable message: short hash, subject, author, body. */
function formatCommit(c: GitCommit): string {
  const short = c.hash.slice(0, 8);
  const lines = c.message.split("\n");
  const subject = lines[0];
  const body = lines.slice(1).join("\n").trim();
  const meta = [c.authorName, c.authorDate?.toLocaleString(vscode.env.language)]
    .filter(Boolean)
    .join(" · ");
  return [`📌 ${short} — ${subject}`, meta, body].filter(Boolean).join("\n");
}

const TELEGRAM_MAX = 4096;

/** Truncate code to fit Telegram's message limit, noting when it was cut. */
function capCode(text: string): string {
  if (text.length <= TELEGRAM_MAX - 16) {
    return text;
  }
  return `${text.slice(0, TELEGRAM_MAX - 16)}\n… ${vscode.l10n.t("(truncated)")}`;
}

/** A short one-line preview of a message for a notification toast. */
function messagePreview(m: Message): string {
  if (m.text) {
    return m.text.length > 100 ? `${m.text.slice(0, 100)}…` : m.text;
  }
  if (m.file) {
    return `📎 ${m.file.name}`;
  }
  if (m.mediaKind === "photo") {
    return vscode.l10n.t("🖼 Photo");
  }
  if (m.mediaKind === "video" || m.mediaKind === "gif") {
    return vscode.l10n.t("🎥 Video");
  }
  if (m.mediaKind === "sticker") {
    return vscode.l10n.t("🖼 Sticker");
  }
  if (m.hasImage) {
    return vscode.l10n.t("🖼 Media");
  }
  return vscode.l10n.t("Attachment");
}
