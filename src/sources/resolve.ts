import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { findLinks, SHORT_HOSTS, type SourceRef } from "./recognize";

// Expand a platform-owned short link to its post, and nothing else. Off unless
// SOURCE_RESOLVE_SHORT_LINKS=1. Every hop must be https on a known platform
// host resolving to a public address; no cookies, no body read, few hops.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Lookup = (host: string) => Promise<{ address: string }[]>;

const MAX_HOPS = 3;
const TIMEOUT_MS = 5_000;

export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:") && privateAddress(v.slice(7));
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export type Resolved = { ok: true; ref: SourceRef } | { ok: false; reason: "disabled" | "not_short" | "unsafe_redirect" | "too_many_hops" | "no_redirect" | "timeout" | "unavailable" };

export async function resolveShortLink(ref: SourceRef, deps: { fetch?: Fetcher; lookup?: Lookup; enabled?: boolean } = {}): Promise<Resolved> {
  const enabled = deps.enabled ?? process.env.SOURCE_RESOLVE_SHORT_LINKS === "1";
  if (!enabled) return { ok: false, reason: "disabled" };
  if (ref.kind !== "short_link") return { ok: false, reason: "not_short" };
  const doFetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const doLookup = deps.lookup ?? ((h) => lookup(h, { all: true }));
  let url = ref.displayUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return { ok: false, reason: "unsafe_redirect" };
    const found = findLinks(url, 1)[0];
    if (!found || found.type !== "social" || found.ref.platform !== ref.platform) return { ok: false, reason: "unsafe_redirect" };
    if (found.ref.kind !== "short_link") return { ok: true, ref: found.ref };
    if (hop === MAX_HOPS) return { ok: false, reason: "too_many_hops" };
    const addrs = await doLookup(u.hostname).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return { ok: false, reason: "unsafe_redirect" };
    let r: Response;
    try {
      r = await doFetch(url, { method: "HEAD", redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { "user-agent": "DadsTyping-link-check/1.0" } });
    } catch (e) {
      return { ok: false, reason: (e as Error)?.name === "TimeoutError" ? "timeout" : "unavailable" };
    }
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) return { ok: false, reason: r.status === 404 ? "unavailable" : "no_redirect" };
    url = new URL(loc, url).toString();
    if (!SHORT_HOSTS.has(new URL(url).hostname) && findLinks(url, 1)[0]?.type !== "social") return { ok: false, reason: "unsafe_redirect" };
  }
  return { ok: false, reason: "too_many_hops" };
}
