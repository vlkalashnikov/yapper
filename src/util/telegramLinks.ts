/**
 * Parse a public t.me / tg://resolve link into a username (+ optional message
 * id). Returns undefined for invites, private links and non-Telegram URLs.
 * Pure and dependency-free, so it can be unit tested in isolation.
 */
export function parseTelegramLink(
  url: string
): { username: string; messageId?: number } | undefined {
  const reserved = new Set([
    "joinchat",
    "addstickers",
    "addemoji",
    "proxy",
    "socks",
    "share",
    "s",
    "c",
  ]);
  let m = /^https?:\/\/t\.me\/([A-Za-z][\w]{3,31})(?:\/(\d+))?\/?(?:\?.*)?$/.exec(url);
  if (m && !reserved.has(m[1].toLowerCase())) {
    return { username: m[1], messageId: m[2] ? Number(m[2]) : undefined };
  }
  m = /^tg:\/\/resolve\?domain=([A-Za-z][\w]{3,31})/.exec(url);
  if (m) {
    return { username: m[1] };
  }
  return undefined;
}
