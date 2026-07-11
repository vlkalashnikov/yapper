import * as vscode from "vscode";
import { Chat, Folder, MessengerProvider, Topic } from "../providers/types";

/**
 * Tree item for a single chat. Shows an unread dot before the title and the
 * last message as the description. Forum chats are expandable into topics.
 */
export class ChatTreeItem extends vscode.TreeItem {
  constructor(public readonly chat: Chat) {
    const unread = (chat.unreadCount ?? 0) > 0;
    // A small "•" marks unread. Indentation under folders is handled natively
    // by VS Code's tree (same as the Explorer) — no manual spacing needed.
    const dot = unread ? "• " : "";
    super(
      `${dot}${chat.title}`,
      chat.isForum
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.description = chat.lastMessage;
    this.tooltip = chat.lastMessage;
    this.iconPath = new vscode.ThemeIcon(
      chat.isForum ? "comment-discussion" : "comment-discussion"
    );
    this.contextValue = chat.isForum ? "yapper.forum" : "yapper.chat";

    // Forum chats expand into topics; only leaf chats open directly.
    if (!chat.isForum) {
      this.command = {
        command: "yapper.openChat",
        title: "Open Chat",
        arguments: [chat],
      };
    }
  }
}

/** Tree item for a forum topic. Opens the chat filtered to that topic. */
export class TopicTreeItem extends vscode.TreeItem {
  constructor(chat: Chat, topic: Topic) {
    const unread = (topic.unreadCount ?? 0) > 0;
    super(
      `${unread ? "• " : ""}${topic.title}`,
      vscode.TreeItemCollapsibleState.None
    );
    this.iconPath = new vscode.ThemeIcon("comment");
    this.contextValue = "yapper.topic";
    // Open the group filtered to this topic (a Chat carrying topicId).
    this.command = {
      command: "yapper.openChat",
      title: "Open Topic",
      arguments: [
        {
          id: chat.id,
          title: topic.title,
          topicId: topic.id,
          unreadCount: topic.unreadCount,
          // Can post only if the group allows it and the topic isn't closed.
          canSend: chat.canSend !== false && !topic.closed,
        } satisfies Chat,
      ],
    };
  }
}

/** Tree item for a folder (dialog filter) containing its chats. */
export class FolderTreeItem extends vscode.TreeItem {
  constructor(public readonly folder: Folder, expanded = false, icon = "folder") {
    super(
      folder.title,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "yapper.folder";
  }
}

type TreeNode = ChatTreeItem | FolderTreeItem | TopicTreeItem;

/**
 * Feeds chats into the sidebar. If the account has folders, chats are grouped
 * under folder nodes (with an "Остальные" node for anything ungrouped);
 * otherwise the list is flat.
 */
export class ChatTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onDidChangeBadge = new vscode.EventEmitter<number>();
  /** Fires with the total unread count whenever the root chat list is rebuilt. */
  readonly onDidChangeBadge = this._onDidChangeBadge.event;

  private chatById = new Map<string, Chat>();

  constructor(private readonly provider: MessengerProvider) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /** The chat with the given id from the last-loaded list, if known. */
  getChatById(id: string): Chat | undefined {
    return this.chatById.get(id);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    // Folder node: return its chats.
    if (element instanceof FolderTreeItem) {
      return element.folder.chatIds
        .map((id) => this.chatById.get(id))
        .filter((c): c is Chat => c !== undefined)
        .map((chat) => new ChatTreeItem(chat));
    }
    // Forum chat node: return its topics.
    if (element instanceof ChatTreeItem && element.chat.isForum) {
      const topics = (await this.provider.getTopics?.(element.chat.id)) ?? [];
      return topics.map((t) => new TopicTreeItem(element.chat, t));
    }
    if (element) {
      return [];
    }

    // Root: fetch chats once, then classify them into folders (no second fetch).
    const chats = await this.provider.getChats();
    const folders = (await this.provider.getFolders?.(chats)) ?? [];
    this.chatById = new Map(chats.map((c) => [c.id, c]));

    // Surface the total unread count for the activity-bar badge.
    const totalUnread = chats.reduce((n, c) => n + (c.unreadCount ?? 0), 0);
    this._onDidChangeBadge.fire(totalUnread);

    // Archived chats are shown only under a dedicated Archive folder, never in
    // the main list or custom folders (mirrors Telegram).
    const active = chats.filter((c) => !c.archived);
    const archived = chats.filter((c) => c.archived);
    const archiveNode = archived.length
      ? new FolderTreeItem(
          {
            id: 1,
            title: vscode.l10n.t("Archived"),
            chatIds: archived.map((c) => c.id),
          },
          false,
          "archive"
        )
      : undefined;

    const nonEmpty = folders.filter((f) => f.chatIds.length > 0);
    if (nonEmpty.length === 0) {
      const items: TreeNode[] = active.map((chat) => new ChatTreeItem(chat));
      if (archiveNode) {
        items.push(archiveNode);
      }
      return items;
    }

    // "Все чаты" mirrors Telegram's first tab; it and the custom folders all
    // start collapsed. Archive, if any, comes last.
    const allChats: Folder = {
      id: 0,
      title: vscode.l10n.t("All chats"),
      chatIds: active.map((c) => c.id),
    };
    const nodes: TreeNode[] = [
      new FolderTreeItem(allChats),
      ...nonEmpty.map((f) => new FolderTreeItem(f)),
    ];
    if (archiveNode) {
      nodes.push(archiveNode);
    }
    return nodes;
  }
}
