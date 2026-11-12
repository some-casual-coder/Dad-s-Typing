// Recognise shared social links in message text. Pure parsing: no network,
// exact platform hosts and known post paths only. A link is a reference to a
// post, never an offer, a video file or permission to read it.
export type Platform = "instagram" | "tiktok" | "facebook" | "youtube" | "x" | "snapchat";
export type Kind = "post" | "reel" | "video" | "short" | "short_link" | "story" | "profile" | "other";

export interface SourceRef {
  platform: Platform;
  kind: Kind;
  canonicalId: string | null;
  // Safe to show and open: https, platform host, no tracking or query params
  displayUrl: string;
  // Dedupes the same post within a task; short links stay distinct until resolved
  identity: string;
  // A post we could, in principle, analyse (not a profile, story or unknown path)
  analysable: boolean;
}

export type Found =
  | { type: "social"; ref: SourceRef }
  | { type: "web"; url: string }
  | { type: "unsafe"; reason: "scheme" | "credentials" | "port" | "malformed" };

export const LABEL: Record<Platform, string> = {
  instagram: "Instagram", tiktok: "TikTok", facebook: "Facebook", youtube: "YouTube", x: "X", snapchat: "Snapchat",
};

const HOSTS: Record<string, Platform> = {
  "instagram.com": "instagram", "www.instagram.com": "instagram", "m.instagram.com": "instagram",
  "tiktok.com": "tiktok", "www.tiktok.com": "tiktok", "m.tiktok.com": "tiktok", "vm.tiktok.com": "tiktok", "vt.tiktok.com": "tiktok",
  "facebook.com": "facebook", "www.facebook.com": "facebook", "m.facebook.com": "facebook", "web.facebook.com": "facebook", "fb.watch": "facebook",
  "youtube.com": "youtube", "www.youtube.com": "youtube", "m.youtube.com": "youtube", "youtu.be": "youtube",
  "x.com": "x", "twitter.com": "x", "www.x.com": "x", "www.twitter.com": "x", "mobile.twitter.com": "x",
  "snapchat.com": "snapchat", "www.snapchat.com": "snapchat",
};

export const SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com", "fb.watch"]);

const CODE = "([A-Za-z0-9_-]{5,40})";
const NUM = "(\\d{6,25})";

type Rule = [RegExp, Kind, (m: RegExpMatchArray) => string | null, (id: string) => string];
const RULES: Record<Platform, Rule[]> = {
  instagram: [
    [new RegExp(`^/(?:[\\w.]+/)?reels?/${CODE}/?$`), "reel", (m) => m[1], (id) => `https://www.instagram.com/reel/${id}/`],
    [new RegExp(`^/(?:[\\w.]+/)?p/${CODE}/?$`), "post", (m) => m[1], (id) => `https://www.instagram.com/p/${id}/`],
    [new RegExp(`^/tv/${CODE}/?$`), "video", (m) => m[1], (id) => `https://www.instagram.com/tv/${id}/`],
    [new RegExp(`^/share/(?:reel/|p/)?${CODE}/?$`), "short_link", () => null, () => ""],
    [/^\/stories\/[\w.]+\/\d+\/?$/, "story", () => null, () => ""],
  ],
  tiktok: [
    [new RegExp(`^/@[\\w.-]+/(?:video|photo)/${NUM}/?$`), "video", (m) => m[1], (id) => `https://www.tiktok.com/video/${id}`],
    [new RegExp(`^/v/${NUM}(?:\\.html)?/?$`), "video", (m) => m[1], (id) => `https://www.tiktok.com/video/${id}`],
    [new RegExp(`^/t/${CODE}/?$`), "short_link", () => null, () => ""],
    [new RegExp(`^/${CODE}/?$`), "short_link", () => null, () => ""],
  ],
  facebook: [
    [new RegExp(`^/reels?/${NUM}/?$`), "reel", (m) => m[1], (id) => `https://www.facebook.com/reel/${id}`],
    [new RegExp(`^/[\\w.-]+/videos/(?:[\\w.-]+/)?${NUM}/?$`), "video", (m) => m[1], (id) => `https://www.facebook.com/watch/?v=${id}`],
    [/^\/watch\/?$/, "video", () => null, (id) => `https://www.facebook.com/watch/?v=${id}`],
    [new RegExp(`^/share/(?:r|v|p)/${CODE}/?$`), "short_link", () => null, () => ""],
    [new RegExp(`^/[\\w.-]+/posts/(?:[\\w.-]+/)?(\\w{6,60})/?$`), "post", (m) => m[1], () => ""],
    [new RegExp(`^/${CODE}/?$`), "short_link", () => null, () => ""],
  ],
  youtube: [
    [/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/, "short", (m) => m[1], (id) => `https://www.youtube.com/shorts/${id}`],
    [/^\/watch\/?$/, "video", () => null, (id) => `https://www.youtube.com/watch?v=${id}`],
    [/^\/([A-Za-z0-9_-]{11})\/?$/, "video", (m) => m[1], (id) => `https://www.youtube.com/watch?v=${id}`],
  ],
  x: [[new RegExp(`^/\\w{1,15}/status/${NUM}/?$`), "post", (m) => m[1], (id) => `https://x.com/i/status/${id}`]],
  snapchat: [[/^\/spotlight\/([A-Za-z0-9_-]{10,80})\/?$/, "video", (m) => m[1], (id) => `https://www.snapchat.com/spotlight/${id}`]],
};

function classify(u: URL, platform: Platform): SourceRef {
  const host = u.hostname.toLowerCase();
  const path = u.pathname.replace(/\/{2,}/g, "/");
  for (const [re, kind, idOf, canon] of RULES[platform]) {
    // Short-link hosts take any code; the main hosts only their known shapes
    if (kind === "short_link" && re.source.startsWith("^/(") && !SHORT_HOSTS.has(host)) continue;
    const m = path.match(re);
    if (!m) continue;
    let id = idOf(m);
    if (!id && kind === "video" && (platform === "facebook" || platform === "youtube")) {
      const v = u.searchParams.get("v");
      id = v && /^[\w-]{6,25}$/.test(v) ? v : null;
      if (!id) break;
    }
    if (kind === "short_link" || kind === "story") {
      const shown = `https://${host}${path.replace(/\/$/, "")}${path.endsWith("/") ? "/" : ""}`;
      return { platform, kind, canonicalId: null, displayUrl: shown, identity: `${platform}:link:${host}${path.replace(/\/$/, "")}`, analysable: kind === "short_link" };
    }
    const display = canon(id!) || `https://${host}${path}`;
    return { platform, kind, canonicalId: id, displayUrl: display, identity: `${platform}:${id}`, analysable: true };
  }
  const profile = /^\/@?[\w.-]{2,40}\/?$/.test(path);
  return { platform, kind: profile ? "profile" : "other", canonicalId: null, displayUrl: `https://${host}${path}`.slice(0, 300),
    identity: `${platform}:other:${host}${path}`.slice(0, 200), analysable: false };
}

const TRAIL = /[)\].,!?;:'"»”’]+$/;
const URLISH = /\b(?:https?:\/\/[^\s<>]+|(?:www\.|m\.|vm\.|vt\.)?(?:instagram\.com|tiktok\.com|facebook\.com|fb\.watch|youtu\.be|youtube\.com|x\.com|twitter\.com|snapchat\.com)\/[^\s<>]*)/gi;

// Links in order of appearance, at most three; text outside them is the shopper's
export function findLinks(text: string, max = 3): Found[] {
  const out: Found[] = [];
  for (const raw of text.match(URLISH) ?? []) {
    if (out.length >= max) break;
    const s = raw.replace(TRAIL, "");
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    let u: URL;
    try { u = new URL(withScheme); } catch { out.push({ type: "unsafe", reason: "malformed" }); continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") { out.push({ type: "unsafe", reason: "scheme" }); continue; }
    if (u.username || u.password) { out.push({ type: "unsafe", reason: "credentials" }); continue; }
    if (u.port && u.port !== "443" && u.port !== "80") { out.push({ type: "unsafe", reason: "port" }); continue; }
    const platform = HOSTS[u.hostname.toLowerCase()];
    out.push(platform ? { type: "social", ref: classify(u, platform) } : { type: "web", url: withScheme });
  }
  return out;
}

// The shopper's own words with social links removed: the model never gets a
// post URL. Other links (a retailer page) stay, as before.
export function withoutSocialLinks(text: string): string {
  return text.replace(URLISH, (raw) => {
    const s = raw.replace(TRAIL, "");
    try {
      const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
      return HOSTS[u.hostname.toLowerCase()] ? " " : raw;
    } catch { return " "; }
  }).replace(/\s{2,}/g, " ").trim();
}
