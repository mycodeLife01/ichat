// Hostname of a source URL, without the leading www. Shared by the sources
// panel and inline citation chips. Kept in its own module so the component
// files only export components (react-refresh).
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Two-part public suffixes where the registrable label sits one level deeper
// (e.g. sina in finance.sina.com.cn). Covers the common ccTLDs we see; anything
// else falls back to a single trailing TLD segment.
const MULTI_TLDS = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.tw", "com.hk", "com.au", "co.jp", "co.kr", "com.br", "co.in", "com.sg",
]);

// Primary site label for a citation chip: the registrable domain without its
// TLD. instagram.com → instagram, ja.wikipedia.org → wikipedia,
// finance.sina.com.cn → sina. Falls back to the full domain when unparseable.
export function siteName(url: string): string {
  const domain = domainOf(url);
  if (!domain) return "";
  const parts = domain.split(".");
  if (parts.length <= 2) return parts[0];
  const tldParts = MULTI_TLDS.has(parts.slice(-2).join(".")) ? 2 : 1;
  return parts[parts.length - 1 - tldParts] ?? parts[0];
}
