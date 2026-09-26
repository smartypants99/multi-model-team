/**
 * Outbound URL policy for model-facing network tools (fetch_url, screenshot).
 * Blocks loopback, link-local, private and cloud-metadata destinations so a
 * prompt-injected model cannot use the engine as a proxy into the host's
 * local services (the dashboard, the MCP server, intranet endpoints).
 */
import dns from "node:dns/promises";
import net from "node:net";

export interface NetPolicy {
  /** Allow 127.0.0.1/localhost (needed for screenshots of a dev server the model started). */
  allowLoopback: boolean;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateAddress(low.slice(7));
    return false;
  }
  return true; // not an IP literal: caller must resolve first
}

export function isLoopbackAddress(ip: string): boolean {
  return ip.startsWith("127.") || ip === "::1" || ip.toLowerCase().startsWith("::ffff:127.");
}

/**
 * Resolve the URL's host and decide. Returns the reason to refuse, or undefined.
 * Decimal/hex IP forms are normalised by the URL parser; DNS names are resolved
 * (all addresses must pass) to defeat rebinding to loopback.
 */
export async function checkOutboundUrl(raw: string, policy: NetPolicy): Promise<string | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "invalid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http(s) URLs are allowed";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata" || host.endsWith(".internal")) {
    return policy.allowLoopback && host === "localhost" ? undefined : `host ${host} is not allowed`;
  }
  let addrs: string[] = [];
  if (net.isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      return `cannot resolve ${host}`;
    }
  }
  if (!addrs.length) return `cannot resolve ${host}`;
  for (const ip of addrs) {
    if (isLoopbackAddress(ip)) {
      if (!policy.allowLoopback) return "loopback addresses are not allowed";
      continue;
    }
    if (isPrivateAddress(ip)) return `${host} resolves to a private, link-local or metadata address (${ip}), which is not allowed`;
  }
  return undefined;
}
