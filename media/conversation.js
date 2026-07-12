// Conversation webview (editor tab). Styled after Claude Code for VS Code.
(function () {
  const vscode = acquireVsCodeApi();
  // Localized strings injected by the extension host (see ConversationPanel.getHtml).
  const L = window.L10N || {};
  const LOCALE = L.locale || undefined;
  // History page size, injected by the host so it stays in sync with the
  // provider's limit (a short page signals the end of history).
  const PAGE_SIZE = (window.YAPPER && window.YAPPER.pageSize) || 50;

  const headerAvatarEl = document.getElementById("header-avatar");
  const titleEl = document.getElementById("title");
  const headerSearchEl = document.getElementById("header-search");
  const threadEl = document.getElementById("thread");
  const messagesEl = document.getElementById("messages");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const mentionPopup = document.getElementById("mention-popup");
  const replyBar = document.getElementById("reply-bar");
  const scrollDownBtn = document.getElementById("scroll-down");
  const olderLoader = document.getElementById("older-loader");

  // Brief "Copied" toast, shown after copying code / an inline fragment.
  let copyToast = null;
  let copyToastTimer = null;
  function showCopied() {
    if (!copyToast) {
      copyToast = document.createElement("div");
      copyToast.id = "copy-toast";
      document.body.appendChild(copyToast);
    }
    copyToast.textContent = L.copied || "Copied";
    copyToast.classList.add("show");
    clearTimeout(copyToastTimer);
    copyToastTimer = setTimeout(() => copyToast.classList.remove("show"), 1400);
  }
  const composer = document.getElementById("composer");
  const readonlyBar = document.getElementById("readonly");
  const lightbox = document.getElementById("lightbox");
  const lbStage = lightbox.querySelector(".lb-stage");
  const lbClose = lightbox.querySelector(".lb-close");
  const profile = document.getElementById("profile");
  const pfCard = profile.querySelector(".pf-card");
  const pfClose = profile.querySelector(".pf-close");
  const headerEl = document.getElementById("header");
  // Profile "shared media/files" tab state.
  let pfContent = null;
  let profileChatId = null;
  let activeSharedTab = null;

  let currentChatId = null;
  let currentCanSend = true;
  // Whether the active provider supports profile cards (Telegram: yes).
  let currentCanProfile = true;
  let chatAvatar = null;
  let lastDay = null;
  // Full history currently held, oldest-first. Re-rendered on pagination.
  let allMessages = [];
  let unreadCount = 0;
  let loadingOlder = false;
  let hasMoreOlder = true;
  // After a jump (search/reply), the live tail isn't loaded — page newer on
  // scroll-down until we reach it. hasMoreNewer is false when viewing the tail.
  let loadingNewer = false;
  let hasMoreNewer = false;
  // When jumping to a reply target not yet loaded: keep paging until found.
  let pendingJump = null;
  let jumpTries = 0;
  // Suppress scroll-triggered loading during programmatic scrolls (jump/prepend).
  let suppressScrollLoad = false;
  // The message currently being replied to, or null.
  let replyingTo = null;
  // messageId -> image container awaiting its thumbnail.
  const pendingImages = new Map();
  // messageId -> data URL (string) or null (failed). Survives re-renders.
  const mediaCache = new Map();

  // @-mention autocomplete state.
  let mentionStart = -1; // index of "@" in the input value, or -1 when inactive
  let mentionQuery = "";
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionTimer = null;

  function initial(name) {
    return (name || "?").trim().charAt(0).toUpperCase() || "?";
  }

  function formatTime(ts) {
    if (!ts) {
      return "";
    }
    try {
      return new Date(ts).toLocaleTimeString(LOCALE, {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }

  function dayKey(ts) {
    if (!ts) {
      return null;
    }
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today - that) / 86400000);
    if (diffDays === 0) {
      return L.today;
    }
    if (diffDays === 1) {
      return L.yesterday;
    }
    return d.toLocaleDateString(LOCALE, {
      day: "numeric",
      month: "long",
      year: that.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  }

  function makeDateSeparator(label) {
    const el = document.createElement("div");
    el.className = "date-sep";
    const span = document.createElement("span");
    span.textContent = label;
    el.append(span);
    return el;
  }

  function makeUnreadSeparator(count) {
    const el = document.createElement("div");
    el.className = "unread-sep";
    const span = document.createElement("span");
    span.textContent = (L.unread || "Unread ({0})").replace("{0}", count);
    el.append(span);
    return el;
  }

  // Render a message, inserting a date separator when the day changes.
  function appendMessage(msg) {
    const key = dayKey(msg.timestamp);
    if (key && key !== lastDay) {
      threadEl.append(makeDateSeparator(dayLabel(msg.timestamp)));
      lastDay = key;
    }
    renderMessage(msg);
  }

  // An avatar node: the photo if available, otherwise a circle with an initial.
  function makeAvatar(name, avatarUrl) {
    if (avatarUrl) {
      const img = document.createElement("img");
      img.className = "avatar";
      img.src = avatarUrl;
      img.alt = "";
      return img;
    }
    const el = document.createElement("div");
    el.className = "avatar initials";
    el.textContent = initial(name);
    return el;
  }

  // Turn URLs, @mentions and file references (path:line[:col]) into clickable
  // links (safe: DOM-built). The @mention must not follow a word char (so emails
  // like a@b don't match). A file ref needs an alphabetic extension + :line.
  const TOKEN_RE =
    /(https?:\/\/\S+)|(?<![\w@])@([A-Za-z0-9_]{2,})|([\w./~-]+\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?::\d+)?)|(?<![\w/])\/([A-Za-z][\w]*(?:@\w+)?)/g;

  function makeLink(url, text) {
    const a = document.createElement("a");
    a.className = "link";
    a.href = url;
    a.dataset.url = url;
    a.textContent = text;
    return a;
  }

  // A clickable file reference like "src/app.ts:42" — opens the file at the line.
  function makeFileLink(token) {
    const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(token);
    const a = document.createElement("a");
    a.className = "link file-link";
    a.textContent = token;
    if (m) {
      a.dataset.file = m[1];
      a.dataset.line = m[2];
      if (m[3]) {
        a.dataset.col = m[3];
      }
    }
    return a;
  }

  function linkify(value) {
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(value))) {
      if (m.index > last) {
        frag.append(value.slice(last, m.index));
      }
      if (m[1]) {
        frag.append(makeLink(m[1], m[1])); // URL
      } else if (m[2]) {
        // @mention → clickable; the host resolves it to a chat via the active
        // provider (Telegram: @username, WhatsApp: phone number) and opens it.
        const a = document.createElement("a");
        a.className = "link mention";
        a.href = "#";
        a.dataset.mention = m[2];
        a.textContent = m[0];
        frag.append(a);
      } else if (m[3]) {
        frag.append(makeFileLink(m[3])); // file:line reference
      } else {
        // Bot command (/command). m[0] keeps the leading slash.
        const el = document.createElement("span");
        el.className = "botcommand";
        el.textContent = m[0];
        frag.append(el);
      }
      last = m.index + m[0].length;
    }
    if (last < value.length) {
      frag.append(value.slice(last));
    }
    return frag;
  }

  // Classify a diff line by its leading marker for git-style coloring.
  function diffLineClass(line) {
    if (/^(diff --git |index |--- |\+\+\+ |new file|deleted file|rename |similarity )/.test(line)) {
      return "d-meta";
    }
    if (line.startsWith("@@")) {
      return "d-hunk";
    }
    if (line.startsWith("+")) {
      return "d-add";
    }
    if (line.startsWith("-")) {
      return "d-del";
    }
    return "d-ctx";
  }

  // Render a unified diff as coloured per-line blocks (added/removed/hunk/meta).
  function renderDiff(text) {
    const frag = document.createDocumentFragment();
    text.split("\n").forEach((line) => {
      const span = document.createElement("span");
      span.className = "diff-line " + diffLineClass(line);
      span.textContent = line.length ? line : " ";
      frag.append(span);
    });
    return frag;
  }

  // Wrap a text slice in nested elements for its active formatting entities.
  function wrapSegment(slice, active) {
    let node = document.createTextNode(slice);
    const has = (t) => active.some((e) => e.type === t);
    const pre = active.find((e) => e.type === "pre");
    if (pre) {
      // A multi-line code block (shared code / diff): block, horizontally scrollable.
      const el = document.createElement("pre");
      el.className = "code-block";
      if ((pre.language || "").toLowerCase() === "diff") {
        el.classList.add("diff");
        el.append(renderDiff(slice)); // git-style per-line coloring
      } else {
        el.append(node);
      }
      // Hover copy button (Claude Code style): copies the raw code to clipboard.
      const wrap = document.createElement("div");
      wrap.className = "code-wrap";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = L.copy || "Copy";
      copy.dataset.code = slice;
      wrap.append(copy, el);
      node = wrap;
    } else if (has("code")) {
      const el = document.createElement("code");
      el.append(node);
      node = el;
    }
    if (has("bold")) {
      const el = document.createElement("strong");
      el.append(node);
      node = el;
    }
    if (has("italic")) {
      const el = document.createElement("em");
      el.append(node);
      node = el;
    }
    if (has("underline")) {
      const el = document.createElement("u");
      el.append(node);
      node = el;
    }
    if (has("strikethrough")) {
      const el = document.createElement("s");
      el.append(node);
      node = el;
    }
    if (has("blockquote")) {
      const el = document.createElement("span");
      el.className = "bq";
      el.append(node);
      node = el;
    }
    if (has("spoiler")) {
      const el = document.createElement("span");
      el.className = "spoiler";
      el.append(node);
      node = el;
    }
    if (has("hashtag")) {
      const el = document.createElement("span");
      el.className = "hashtag";
      el.append(node);
      node = el;
    }
    if (has("botcommand")) {
      const el = document.createElement("span");
      el.className = "botcommand";
      el.append(node);
      node = el;
    }
    const link = active.find((e) => e.type === "link" || e.type === "mention");
    if (link) {
      const a = document.createElement("a");
      a.className = "link";
      a.href = link.url;
      a.dataset.url = link.url;
      a.append(node);
      node = a;
    }
    return node;
  }

  // Render text with provider-agnostic formatting entities. Falls back to the
  // regex linkifier when a message carries no entities (e.g. mock provider).
  function renderRichText(value, entities) {
    if (!entities || !entities.length) {
      return linkify(value);
    }
    const bounds = new Set([0, value.length]);
    entities.forEach((e) => {
      bounds.add(e.offset);
      bounds.add(e.offset + e.length);
    });
    const points = [...bounds]
      .filter((p) => p >= 0 && p <= value.length)
      .sort((a, b) => a - b);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i];
      const end = points[i + 1];
      if (start === end) {
        continue;
      }
      const active = entities.filter(
        (e) => e.offset <= start && e.offset + e.length >= end
      );
      frag.append(wrapSegment(value.slice(start, end), active));
    }
    return frag;
  }

  function textNode(value, entities) {
    const text = document.createElement("div");
    text.className = "text";
    text.append(renderRichText(value, entities));
    return text;
  }

  function playBadge() {
    const play = document.createElement("div");
    play.className = "play";
    play.textContent = "▶";
    return play;
  }

  // Delivery mark for an outgoing message: ✓ sent, ✓✓ read.
  function statusMark(status) {
    const s = document.createElement("span");
    s.className = "status" + (status === "read" ? " read" : "");
    s.textContent = status === "read" ? "✓✓" : "✓";
    return s;
  }

  // A quoted preview of the replied-to message. Click jumps to the original.
  function makeReplyQuote(reply) {
    const q = document.createElement("div");
    q.className = "reply-quote";
    q.dataset.replyTo = reply.id;
    q.title = L.goToMessage;
    const author = document.createElement("div");
    author.className = "r-author";
    author.textContent = reply.author || L.message;
    const text = document.createElement("div");
    text.className = "r-text";
    text.textContent = reply.text || "";
    q.append(author, text);
    return q;
  }

  // A lazily-loaded image. Uses the cache so re-renders don't re-download.
  // Clicking it opens the full media (image viewer / video player).
  function makeImage(msg) {
    const wrap = document.createElement("div");
    wrap.className = "msg-image";
    wrap.dataset.messageId = msg.id;
    const isVideo = msg.mediaKind === "video" || msg.mediaKind === "gif";
    if (isVideo) {
      wrap.dataset.video = "1";
    }

    const cached = mediaCache.get(msg.id);
    if (cached) {
      const img = document.createElement("img");
      img.src = cached;
      img.alt = "";
      wrap.append(img);
      if (isVideo) {
        wrap.append(playBadge());
      }
    } else if (cached === null) {
      wrap.classList.add("failed");
      wrap.append(document.createTextNode(L.image));
    } else {
      wrap.classList.add("loading");
      if (isVideo) {
        wrap.append(playBadge());
      }
      pendingImages.set(msg.id, wrap);
      vscode.postMessage({
        type: "requestMedia",
        chatId: currentChatId,
        messageId: msg.id,
      });
    }
    return wrap;
  }

  // Human-readable file size (bytes → localized units).
  function formatSize(bytes) {
    if (!bytes || bytes < 0) {
      return "";
    }
    const units = L.sizeUnits || ["B", "KB", "MB", "GB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return (i === 0 ? n : n.toFixed(1)) + " " + units[i];
  }

  // A downloadable file chip (documents, audio, voice). Click downloads it.
  function makeFile(msg) {
    const el = document.createElement("div");
    el.className = "msg-file";
    el.dataset.messageId = msg.id;
    el.title = L.download;
    const icon = document.createElement("div");
    icon.className = "file-icon";
    icon.textContent = "📎";
    const info = document.createElement("div");
    info.className = "file-info";
    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = msg.file.name;
    info.append(name);
    const size = formatSize(msg.file.size);
    if (size) {
      const s = document.createElement("div");
      s.className = "file-size";
      s.textContent = size;
      info.append(s);
    }
    el.append(icon, info);
    return el;
  }

  // A short one-line preview of a message (for reply bar / quote).
  function snippetOf(msg) {
    if (msg.text) {
      return msg.text.length > 80 ? msg.text.slice(0, 80) + "…" : msg.text;
    }
    if (msg.file) return "📎 " + msg.file.name;
    if (msg.mediaKind === "photo") return L.photo;
    if (msg.mediaKind === "video") return L.video;
    if (msg.mediaKind === "gif") return L.gif;
    if (msg.mediaKind === "sticker") return L.sticker;
    if (msg.hasImage) return L.media;
    return "";
  }

  // Hover actions on a message (currently: reply).
  function makeActions(msg) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const reply = document.createElement("button");
    reply.className = "reply-btn";
    reply.title = L.reply;
    reply.textContent = "↩";
    reply.dataset.id = msg.id;
    reply.dataset.author = msg.outgoing ? L.you : msg.author;
    reply.dataset.text = snippetOf(msg);
    actions.append(reply);
    return actions;
  }

  function buildMessageEl(msg) {
    const el = document.createElement("div");
    el.dataset.messageId = msg.id;
    const time = formatTime(msg.timestamp);

    if (msg.outgoing) {
      el.className = "msg outgoing";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      if (msg.reply) {
        bubble.append(makeReplyQuote(msg.reply));
      }
      if (msg.hasImage) {
        bubble.append(makeImage(msg));
      }
      if (msg.file) {
        bubble.append(makeFile(msg));
      }
      if (msg.text) {
        bubble.append(textNode(msg.text, msg.entities));
      }
      if (time || msg.edited || msg.status) {
        const t = document.createElement("div");
        t.className = "time";
        t.textContent = (msg.edited ? L.edited + " " : "") + time;
        if (msg.status) {
          t.append(" ", statusMark(msg.status));
        }
        bubble.append(t);
      }
      el.append(makeActions(msg), bubble);
    } else {
      el.className = "msg incoming";
      const body = document.createElement("div");
      body.className = "body";
      const meta = document.createElement("div");
      meta.className = "meta";
      const author = document.createElement("span");
      author.className = "author";
      author.textContent = msg.author;
      if (msg.senderId) {
        author.classList.add("clickable-user");
        author.dataset.senderId = msg.senderId;
      }
      meta.append(author);
      if (time || msg.edited) {
        const t = document.createElement("span");
        t.className = "time";
        t.textContent = (msg.edited ? L.edited + " " : "") + time;
        meta.append(t);
      }
      body.append(meta);
      if (msg.reply) {
        body.append(makeReplyQuote(msg.reply));
      }
      if (msg.hasImage) {
        body.append(makeImage(msg));
      }
      if (msg.file) {
        body.append(makeFile(msg));
      }
      if (msg.text) {
        body.append(textNode(msg.text, msg.entities));
      }
      const av = makeAvatar(msg.author, msg.avatar);
      if (msg.senderId) {
        av.classList.add("clickable-user");
        av.dataset.senderId = msg.senderId;
      }
      el.append(av, body, makeActions(msg));
    }

    return el;
  }

  function renderMessage(msg) {
    threadEl.append(buildMessageEl(msg));
  }

  // Replace an edited message in place.
  function updateMessage(msg) {
    const idx = allMessages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      allMessages[idx] = msg;
    }
    const el = findMessageEl(msg.id);
    if (el) {
      el.replaceWith(buildMessageEl(msg));
    }
  }

  // Mark outgoing messages up to maxId as read (✓ → ✓✓).
  function applyReadOutbox(maxId) {
    const max = Number(maxId);
    allMessages.forEach((m) => {
      if (!m.outgoing || m.status === "read" || Number(m.id) > max) {
        return;
      }
      m.status = "read";
      const el = findMessageEl(m.id);
      const s = el && el.querySelector(".status");
      if (s) {
        s.textContent = "✓✓";
        s.classList.add("read");
      }
    });
  }

  // Remove deleted messages from the thread.
  function deleteMessages(ids) {
    const set = new Set(ids);
    allMessages = allMessages.filter((m) => !set.has(m.id));
    ids.forEach((id) => {
      const el = findMessageEl(id);
      if (el) {
        el.remove();
      }
    });
  }

  function startReply(id, author, text) {
    replyingTo = { id: id, author: author, text: text };
    replyBar.replaceChildren();
    const info = document.createElement("div");
    info.className = "rb-info";
    const a = document.createElement("div");
    a.className = "rb-author";
    a.textContent = L.replyPrefix + " " + author;
    const t = document.createElement("div");
    t.className = "rb-text";
    t.textContent = text;
    info.append(a, t);
    const cancel = document.createElement("button");
    cancel.className = "rb-cancel";
    cancel.title = L.cancel;
    cancel.textContent = "✕";
    cancel.addEventListener("click", cancelReply);
    replyBar.append(info, cancel);
    replyBar.classList.remove("hidden");
    input.focus();
  }

  function cancelReply() {
    replyingTo = null;
    replyBar.classList.add("hidden");
    replyBar.replaceChildren();
  }

  function guardScroll() {
    suppressScrollLoad = true;
    setTimeout(() => {
      suppressScrollLoad = false;
    }, 350);
  }

  function flashMessage(el) {
    guardScroll();
    el.scrollIntoView({ block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("flash");
  }

  function findMessageEl(id) {
    return threadEl.querySelector(`.msg[data-message-id="${id}"]`);
  }

  function jumpToMessage(id) {
    const el = findMessageEl(id);
    if (el) {
      pendingJump = null;
      flashMessage(el);
      return;
    }
    // Not loaded yet — page older history until it appears.
    if (!hasMoreOlder) {
      return;
    }
    pendingJump = id;
    jumpTries = 0;
    requestOlder();
  }

  // Continue a pending jump after a page of older messages arrives.
  function continueJump() {
    if (pendingJump === null) {
      return;
    }
    const el = findMessageEl(pendingJump);
    if (el) {
      pendingJump = null;
      flashMessage(el);
    } else if (hasMoreOlder && jumpTries++ < 40) {
      requestOlder();
    } else {
      // Too far to reach by paging — load a window around it directly.
      const id = pendingJump;
      pendingJump = null;
      if (currentChatId) {
        vscode.postMessage({
          type: "requestAround",
          chatId: currentChatId,
          messageId: id,
        });
      }
    }
  }

  // Toggle the older-history fetch state and its top spinner together.
  function setLoadingOlder(v) {
    loadingOlder = v;
    if (olderLoader) {
      olderLoader.classList.toggle("hidden", !v);
    }
  }

  function requestOlder() {
    if (loadingOlder || !hasMoreOlder || !allMessages.length || !currentChatId) {
      return;
    }
    setLoadingOlder(true);
    vscode.postMessage({
      type: "loadOlder",
      chatId: currentChatId,
      beforeId: allMessages[0].id,
    });
  }

  function isNearBottom() {
    return (
      messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120
    );
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Show the "scroll to bottom" button when scrolled up, or (after a jump) while
  // the live tail isn't loaded — then it jumps back to the latest messages.
  function updateScrollButton() {
    scrollDownBtn.classList.toggle("hidden", isNearBottom() && !hasMoreNewer);
  }

  function applyMedia(messageId, dataUrl) {
    mediaCache.set(messageId, dataUrl || null);
    const wrap = pendingImages.get(messageId);
    if (!wrap) {
      return;
    }
    pendingImages.delete(messageId);
    const near = isNearBottom();
    wrap.classList.remove("loading");
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "";
      wrap.replaceChildren(img);
      if (wrap.dataset.video) {
        wrap.append(playBadge());
      }
    } else {
      wrap.classList.add("failed");
      wrap.replaceChildren(document.createTextNode(L.image));
    }
    if (near) {
      scrollToBottom();
    }
  }

  // Full re-render of allMessages. scrollMode: "unread" | "preserve" | "bottom".
  function renderAll(scrollMode) {
    const prevHeight = messagesEl.scrollHeight;
    const prevTop = messagesEl.scrollTop;

    lastDay = null;
    pendingImages.clear();
    threadEl.replaceChildren();

    if (!allMessages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = L.empty;
      threadEl.append(empty);
      return;
    }

    const firstUnread = unreadCount > 0 ? allMessages.length - unreadCount : -1;
    let unreadEl = null;
    allMessages.forEach((m, i) => {
      if (i === firstUnread) {
        unreadEl = makeUnreadSeparator(unreadCount);
        threadEl.append(unreadEl);
      }
      appendMessage(m);
    });

    if (scrollMode === "unread" && unreadEl) {
      unreadEl.scrollIntoView({ block: "start" });
    } else if (scrollMode === "preserve") {
      // Content added at the top (older) — shift down to stay in place.
      messagesEl.scrollTop = messagesEl.scrollHeight - (prevHeight - prevTop);
    } else if (scrollMode === "keep") {
      // Content added at the bottom (newer) — keep the viewport exactly put.
      messagesEl.scrollTop = prevTop;
    } else {
      scrollToBottom();
    }
  }

  function stateNode(children) {
    const el = document.createElement("div");
    el.className = "state";
    el.append(...children);
    return el;
  }

  function showLoading(chat) {
    currentChatId = chat.id;
    chatAvatar = null;
    lastDay = null;
    // Reset pagination state so a stale loader from the previous chat doesn't
    // linger (e.g. a second spinner over "Loading messages…").
    setLoadingOlder(false);
    hasMoreOlder = true;
    loadingNewer = false;
    hasMoreNewer = false;
    setHeader(chat);
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    const label = document.createElement("div");
    label.textContent = L.loading;
    threadEl.replaceChildren(stateNode([spinner, label]));
    updateSendState();
    updateComposerAccess(chat.canSend);
  }

  function showError(chat, message) {
    currentChatId = chat.id;
    setHeader(chat);
    const label = document.createElement("div");
    label.textContent = L.loadFailed;
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = message || L.checkConnection;
    const retry = document.createElement("button");
    retry.className = "retry";
    retry.textContent = L.retry;
    retry.addEventListener("click", () => {
      if (currentChatId) {
        vscode.postMessage({ type: "retry", chatId: currentChatId });
      }
    });
    threadEl.replaceChildren(stateNode([label, detail, retry]));
    updateSendState();
    updateComposerAccess(chat.canSend);
  }

  function setHeader(chat) {
    titleEl.textContent = chat.title;
    headerAvatarEl.replaceChildren(makeAvatar(chat.title, chatAvatar));
  }

  function load(chat, messages, avatar, unread, canSend, canProfile) {
    currentChatId = chat.id;
    currentCanProfile = canProfile !== false;
    chatAvatar = avatar || null;
    allMessages = messages || [];
    unreadCount = unread || 0;
    setLoadingOlder(false);
    hasMoreOlder = true;
    loadingNewer = false;
    hasMoreNewer = false; // a normal open shows the live tail
    pendingJump = null;
    mediaCache.clear();
    hideMentionPopup();
    cancelReply();
    closeProfile(); // opening a chat (e.g. via a t.me link) closes overlays
    closeLightbox();
    setHeader(chat);
    renderAll("unread");
    updateScrollButton();
    updateSendState();
    updateComposerAccess(canSend);
    if (canSend !== false) {
      input.focus();
    }
  }

  function prependOlder(messages) {
    setLoadingOlder(false);
    if (!messages || !messages.length) {
      hasMoreOlder = false;
      continueJump();
      return;
    }
    allMessages = messages.concat(allMessages);
    guardScroll();
    renderAll("preserve");
    continueJump();
  }

  // Replace the thread with a window of history around a target message (from
  // search / jump) and flash it — works even for messages far outside the view.
  function loadAround(messages, targetId) {
    if (!messages || !messages.length) {
      return;
    }
    allMessages = messages;
    unreadCount = 0;
    setLoadingOlder(false);
    hasMoreOlder = true;
    loadingNewer = false;
    hasMoreNewer = true; // the live tail isn't loaded after a jump
    pendingJump = null;
    mediaCache.clear();
    hideMentionPopup();
    renderAll("bottom");
    updateScrollButton();
    const el = findMessageEl(targetId);
    if (el) {
      flashMessage(el);
    }
  }

  function requestNewer() {
    if (loadingNewer || !hasMoreNewer || !allMessages.length || !currentChatId) {
      return;
    }
    loadingNewer = true;
    vscode.postMessage({
      type: "loadNewer",
      chatId: currentChatId,
      afterId: allMessages[allMessages.length - 1].id,
    });
  }

  function appendNewerMessages(messages) {
    loadingNewer = false;
    const raw = messages || [];
    // A partial page means we've reached the latest message.
    if (raw.length < PAGE_SIZE) {
      hasMoreNewer = false;
    }
    const have = new Set(allMessages.map((m) => m.id));
    const fresh = raw.filter((m) => !have.has(m.id));
    if (fresh.length) {
      allMessages = allMessages.concat(fresh);
      guardScroll();
      renderAll("keep");
    }
    updateScrollButton();
  }

  // --- lightbox (full-size image / video overlay) ---

  function showLightbox(url, kind, messageId) {
    lbStage.replaceChildren();
    if (kind === "video") {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      lbStage.append(video);
      // The webview can't decode the audio track — offer the OS player for sound.
      const sound = document.createElement("button");
      sound.className = "lb-sound";
      sound.textContent = "🔊 " + (L.openWithSound || "Open with sound");
      sound.addEventListener("click", () => {
        vscode.postMessage({
          type: "openMediaExternal",
          chatId: currentChatId,
          messageId: messageId,
        });
      });
      lbStage.append(sound);
    } else {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      lbStage.append(img);
    }
    lightbox.classList.remove("hidden");
  }

  function closeLightbox() {
    lightbox.classList.add("hidden");
    lbStage.replaceChildren(); // stop any video playback
  }

  headerSearchEl.addEventListener("click", () => {
    if (currentChatId) {
      vscode.postMessage({ type: "searchChat" });
    }
  });

  // Click the header (avatar / title, not the search icon) to open the profile.
  headerEl.addEventListener("click", (e) => {
    if (e.target.closest("#header-search")) {
      return;
    }
    if (currentChatId && currentCanProfile) {
      showProfileLoading(); // show the overlay immediately while data loads
      vscode.postMessage({ type: "openProfile" });
    }
  });

  function showProfileLoading() {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    pfCard.replaceChildren(spinner);
    profile.classList.remove("hidden");
  }

  // --- profile overlay ---

  function pfRow(text, cls) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function showProfile(p, chatId) {
    pfCard.replaceChildren();
    const av = makeAvatar(p.title, p.avatar);
    av.classList.add("pf-avatar"); // marked so the streamed big avatar can replace it
    pfCard.append(av);
    pfCard.append(pfRow(p.title, "pf-title"));
    if (p.subtitle) {
      pfCard.append(pfRow(p.subtitle, "pf-subtitle"));
    }
    if (p.username) {
      const u = document.createElement("a");
      u.className = "pf-username link";
      u.textContent = "@" + p.username;
      u.dataset.url = "https://t.me/" + p.username;
      pfCard.append(u);
    }

    // Actions + shared media are only meaningful for the currently-open chat;
    // for another user's profile (from a group message) show info only.
    const forCurrentChat = chatId === currentChatId;

    // Action buttons: mute/unmute toggle + search in chat.
    const actions = document.createElement("div");
    actions.className = "pf-actions";
    const muteBtn = document.createElement("button");
    muteBtn.className = "pf-btn";
    const setMuteLabel = () => {
      muteBtn.textContent = p.muted
        ? "🔔 " + (L.unmute || "Unmute")
        : "🔕 " + (L.mute || "Mute");
    };
    setMuteLabel();
    muteBtn.addEventListener("click", () => {
      p.muted = !p.muted;
      setMuteLabel();
      vscode.postMessage({ type: "setMuted", chatId: chatId, muted: p.muted });
    });
    const searchBtn = document.createElement("button");
    searchBtn.className = "pf-btn";
    searchBtn.textContent = "🔍 " + (L.search || "Search");
    searchBtn.addEventListener("click", () => {
      closeProfile();
      vscode.postMessage({ type: "searchChat" });
    });
    actions.append(muteBtn, searchBtn);
    if (forCurrentChat) {
      pfCard.append(actions);
    }

    if (p.bio) {
      const bio = document.createElement("div");
      bio.className = "pf-bio";
      bio.append(linkify(p.bio)); // format @mentions and URLs in the bio
      pfCard.append(bio);
    }
    if (p.phone) {
      pfCard.append(pfRow("📞 " + p.phone, "pf-phone"));
    }
    if (p.commonChats) {
      const t = (L.commonChats || "{0} groups in common").replace(
        "{0}",
        p.commonChats
      );
      pfCard.append(pfRow(t, "pf-common"));
    }
    if (p.inviteLink) {
      const inv = document.createElement("div");
      inv.className = "pf-invite";
      inv.textContent = "🔗 " + p.inviteLink;
      inv.title = L.copyInvite || "Copy invite link";
      inv.addEventListener("click", () => {
        vscode.postMessage({ type: "copyText", text: p.inviteLink });
      });
      pfCard.append(inv);
    }

    // Shared media / files tabs (current chat only).
    profileChatId = chatId;
    activeSharedTab = null;
    if (forCurrentChat) {
      const tabs = document.createElement("div");
      tabs.className = "pf-tabs";
      tabs.append(
        sharedTab(L.mediaTab || "Media", "media"),
        sharedTab(L.filesTab || "Files", "files")
      );
      pfContent = document.createElement("div");
      pfContent.className = "pf-shared";
      pfCard.append(tabs, pfContent);
    }

    profile.classList.remove("hidden");
  }

  function sharedTab(label, kind) {
    const btn = document.createElement("button");
    btn.className = "pf-tab";
    btn.textContent = label;
    btn.dataset.kind = kind;
    btn.addEventListener("click", () => loadShared(kind));
    return btn;
  }

  function loadShared(kind) {
    if (!profileChatId) {
      return;
    }
    activeSharedTab = kind;
    pfCard.querySelectorAll(".pf-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.kind === kind);
    });
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    pfContent.replaceChildren(spinner);
    vscode.postMessage({ type: "loadShared", chatId: profileChatId, kind });
  }

  function renderShared(kind, messages) {
    if (kind !== activeSharedTab) {
      return; // a different tab was selected meanwhile
    }
    const items = (messages || []).filter((m) =>
      kind === "files" ? m.file : m.hasImage
    );
    if (!items.length) {
      pfContent.className = "pf-shared";
      pfContent.replaceChildren(pfRow(L.nothingHere || "Nothing here", "pf-empty"));
      return;
    }
    if (kind === "files") {
      pfContent.className = "pf-shared pf-files";
      pfContent.replaceChildren(...items.map(makeFile));
    } else {
      pfContent.className = "pf-shared pf-grid";
      pfContent.replaceChildren(...items.map(makeImage));
    }
  }

  function closeProfile() {
    profile.classList.add("hidden");
    pfCard.replaceChildren();
    pfContent = null;
    activeSharedTab = null;
    profileChatId = null;
  }

  // The big avatar arrives after the card — swap it in for the initials.
  function applyProfileAvatar(url, chatId) {
    if (profile.classList.contains("hidden") || !url || chatId !== profileChatId) {
      return;
    }
    const cur = pfCard.querySelector(".pf-avatar");
    if (!cur) {
      return;
    }
    const img = makeAvatar("", url);
    img.classList.add("pf-avatar");
    cur.replaceWith(img);
  }

  pfClose.addEventListener("click", closeProfile);
  profile.addEventListener("click", (e) => {
    if (e.target === profile) {
      closeProfile();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !profile.classList.contains("hidden")) {
      closeProfile();
    }
  });

  lbClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) {
      closeLightbox(); // click on the backdrop, not the media
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !lightbox.classList.contains("hidden")) {
      closeLightbox();
    }
  });

  function updateSendState() {
    sendBtn.disabled = input.value.trim().length === 0 || !currentChatId;
  }

  // Hide the composer and show a read-only note when the user can't post here.
  function updateComposerAccess(canSend) {
    currentCanSend = canSend !== false;
    const readonly = !currentCanSend;
    composer.classList.toggle("hidden", readonly);
    readonlyBar.classList.toggle("hidden", !readonly);
  }

  function send() {
    const text = input.value.trim();
    if (!text || !currentChatId) {
      return;
    }
    vscode.postMessage({
      type: "send",
      chatId: currentChatId,
      text,
      replyToId: replyingTo ? replyingTo.id : undefined,
    });
    input.value = "";
    input.style.height = "auto";
    cancelReply();
    updateSendState();
  }

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  // --- @-mention autocomplete ---

  const mentionOpen = () => mentionStart >= 0 && mentionItems.length > 0;

  function detectMention() {
    const before = input.value.slice(0, input.selectionStart);
    const m = /(^|\s)@([^\s@]*)$/u.exec(before);
    if (!m) {
      hideMentionPopup();
      return;
    }
    mentionQuery = m[2];
    mentionStart = input.selectionStart - m[2].length - 1;
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(() => {
      if (currentChatId) {
        vscode.postMessage({
          type: "searchMembers",
          chatId: currentChatId,
          query: mentionQuery,
        });
      }
    }, 150);
  }

  function onMembers(query, members) {
    if (mentionStart < 0 || query !== mentionQuery) {
      return; // stale response
    }
    mentionItems = members || [];
    mentionIndex = 0;
    if (!mentionItems.length) {
      hideMentionPopup();
      return;
    }
    renderMentionPopup();
    mentionPopup.classList.remove("hidden");
  }

  function renderMentionPopup() {
    mentionPopup.replaceChildren();
    mentionItems.forEach((member, i) => {
      const row = document.createElement("div");
      row.className = "mention-item" + (i === mentionIndex ? " active" : "");
      row.dataset.index = String(i);
      row.append(makeAvatar(member.name, null));
      const name = document.createElement("span");
      name.className = "m-name";
      name.textContent = member.name;
      row.append(name);
      if (member.username) {
        const u = document.createElement("span");
        u.className = "m-username";
        u.textContent = "@" + member.username;
        row.append(u);
      }
      mentionPopup.append(row);
    });
  }

  function moveMention(delta) {
    mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
    renderMentionPopup();
  }

  function hideMentionPopup() {
    clearTimeout(mentionTimer);
    mentionStart = -1;
    mentionQuery = "";
    mentionItems = [];
    mentionPopup.classList.add("hidden");
  }

  function selectMember(member) {
    if (!member) {
      return;
    }
    const before = input.value.slice(0, mentionStart);
    const after = input.value.slice(input.selectionStart);
    const token = member.username ? "@" + member.username : member.name;
    const insert = token + " ";
    input.value = before + insert + after;
    const caret = (before + insert).length;
    hideMentionPopup();
    input.focus();
    input.setSelectionRange(caret, caret);
    autoGrow();
    updateSendState();
  }

  // Selecting via mousedown keeps focus in the textarea (avoids blur closing).
  mentionPopup.addEventListener("mousedown", (e) => {
    const row = e.target.closest?.(".mention-item");
    if (row) {
      e.preventDefault();
      selectMember(mentionItems[Number(row.dataset.index)]);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (mentionOpen()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveMention(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveMention(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMember(mentionItems[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionPopup();
        return;
      }
    }
    if (e.key === "Escape" && replyingTo) {
      e.preventDefault();
      cancelReply();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  input.addEventListener("input", () => {
    autoGrow();
    updateSendState();
    detectMention();
  });

  sendBtn.addEventListener("click", send);

  document.getElementById("attach").addEventListener("click", () => {
    if (currentChatId) {
      vscode.postMessage({ type: "composerMenu" });
    }
  });

  // Load older near the top; after a jump, load newer near the bottom.
  messagesEl.addEventListener("scroll", () => {
    if (!suppressScrollLoad && messagesEl.scrollTop < 80) {
      requestOlder();
    }
    if (!suppressScrollLoad && hasMoreNewer && isNearBottom()) {
      requestNewer();
    }
    updateScrollButton();
  });

  scrollDownBtn.addEventListener("click", () => {
    // After a jump the tail isn't loaded — reload the chat to return to live.
    if (hasMoreNewer && currentChatId) {
      vscode.postMessage({ type: "requestLatest", chatId: currentChatId });
      return;
    }
    scrollToBottom();
    updateScrollButton();
  });

  // Clicks on links open externally; clicks on images open the full media.
  document.addEventListener("click", (e) => {
    const copyBtn = e.target.closest?.("button.code-copy");
    if (copyBtn) {
      vscode.postMessage({ type: "copy", text: copyBtn.dataset.code });
      showCopied();
      return;
    }
    // Click an inline formatted fragment (inline code) → copy just that text.
    const inlineCode = e.target.closest?.(".msg .text code");
    if (inlineCode && (window.getSelection?.()?.isCollapsed ?? true)) {
      vscode.postMessage({ type: "copy", text: inlineCode.textContent });
      showCopied();
      return;
    }
    const spoiler = e.target.closest?.(".spoiler:not(.revealed)");
    if (spoiler) {
      spoiler.classList.add("revealed");
      return;
    }
    // Click a message author's name/avatar → open their profile.
    const user = e.target.closest?.(".clickable-user");
    if (user && user.dataset.senderId && currentCanProfile) {
      showProfileLoading();
      vscode.postMessage({ type: "openProfile", chatId: user.dataset.senderId });
      return;
    }
    const fileLink = e.target.closest?.("a.file-link");
    if (fileLink) {
      e.preventDefault();
      vscode.postMessage({
        type: "openFile",
        file: fileLink.dataset.file,
        line: fileLink.dataset.line ? Number(fileLink.dataset.line) : undefined,
        column: fileLink.dataset.col ? Number(fileLink.dataset.col) : undefined,
      });
      return;
    }
    const mention = e.target.closest?.("a.mention");
    if (mention) {
      e.preventDefault();
      vscode.postMessage({ type: "openMention", query: mention.dataset.mention });
      return;
    }
    const link = e.target.closest?.("a.link");
    if (link) {
      e.preventDefault();
      vscode.postMessage({ type: "openLink", url: link.dataset.url });
      return;
    }
    // Click a bot command (/start) to send it, like Telegram.
    const botcmd = e.target.closest?.(".botcommand");
    if (botcmd) {
      if (currentChatId && currentCanSend) {
        vscode.postMessage({
          type: "send",
          chatId: currentChatId,
          text: botcmd.textContent,
        });
      }
      return;
    }
    const replyBtn = e.target.closest?.(".reply-btn");
    if (replyBtn) {
      startReply(replyBtn.dataset.id, replyBtn.dataset.author, replyBtn.dataset.text);
      return;
    }
    const reply = e.target.closest?.(".reply-quote");
    if (reply) {
      jumpToMessage(reply.dataset.replyTo);
      return;
    }
    const image = e.target.closest?.(".msg-image");
    if (image && image.dataset.messageId && !image.classList.contains("loading")) {
      vscode.postMessage({
        type: "openMedia",
        chatId: currentChatId,
        messageId: image.dataset.messageId,
      });
      return;
    }
    const file = e.target.closest?.(".msg-file");
    if (file && file.dataset.messageId) {
      vscode.postMessage({
        type: "openMedia",
        chatId: currentChatId,
        messageId: file.dataset.messageId,
      });
    }
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "loading":
        showLoading(msg.chat);
        break;
      case "error":
        showError(msg.chat, msg.message);
        break;
      case "load":
        load(
          msg.chat,
          msg.messages,
          msg.avatar,
          msg.unreadCount,
          msg.canSend,
          msg.canProfile
        );
        break;
      case "headerAvatar":
        // The chat avatar arrives after the messages — swap it into the header.
        if (msg.chatId === currentChatId && msg.avatar) {
          chatAvatar = msg.avatar;
          headerAvatarEl.replaceChildren(makeAvatar(titleEl.textContent, chatAvatar));
        }
        break;
      case "prepend":
        if (msg.chatId === currentChatId) {
          prependOlder(msg.messages);
        }
        break;
      case "appendNewer":
        if (msg.chatId === currentChatId) {
          appendNewerMessages(msg.messages);
        }
        break;
      case "append": {
        // While viewing a jumped-to window (tail not loaded), a live message
        // belongs after unloaded history — don't append it into the gap.
        if (hasMoreNewer) {
          if (msg.message.outgoing && currentChatId) {
            // The user sent it — return to live so they see it in context.
            vscode.postMessage({ type: "requestLatest", chatId: currentChatId });
          }
          break;
        }
        allMessages.push(msg.message);
        const near = isNearBottom();
        appendMessage(msg.message);
        if (near || msg.message.outgoing) {
          scrollToBottom();
        }
        updateScrollButton();
        break;
      }
      case "sendFailed":
        // Restore the unsent text if the user hasn't typed something new.
        if (!input.value.trim()) {
          input.value = msg.text;
          autoGrow();
          updateSendState();
          input.focus();
        }
        break;
      case "update":
        updateMessage(msg.message);
        break;
      case "delete":
        deleteMessages(msg.ids);
        break;
      case "readOutbox":
        applyReadOutbox(msg.maxId);
        break;
      case "media":
        applyMedia(msg.messageId, msg.dataUrl);
        break;
      case "lightbox":
        showLightbox(msg.url, msg.kind, msg.messageId);
        break;
      case "loadAround":
        loadAround(msg.messages, msg.targetId);
        break;
      case "profile":
        showProfile(msg.profile, msg.chatId);
        break;
      case "shared":
        renderShared(msg.kind, msg.messages);
        break;
      case "profileError":
        closeProfile();
        break;
      case "profileAvatar":
        applyProfileAvatar(msg.avatar, msg.chatId);
        break;
      case "members":
        onMembers(msg.query, msg.members);
        break;
    }
  });
})();
