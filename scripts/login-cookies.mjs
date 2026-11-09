import path from "node:path";
import { VeniceWebClient } from "../src/client.mjs";
import {
  isVeniceCookieDomain,
  saveCapturedSession,
  toSessionCookie,
} from "./login-google.mjs";

// Manual login path for machines that cannot run a browser (or for people who
// just do not want the automation): the user signs in to Venice with Google in
// their own browser, copies the `__client` cookie, and the proxy turns that one
// value into a normal session file. Nothing is launched, so it works from a
// headless server as long as the browser ran somewhere else.
//
// Verified against Clerk: the `__client` cookie alone is enough to resolve the
// session, mint a JWT and restore the outerface login. The other Venice cookies
// are accepted too, but they are optional.

const COOKIE_ATTRIBUTES = new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "samesite",
  "secure",
  "httponly",
]);

function inferDomain(name) {
  if (name === "__client") {
    return { domain: "clerk.venice.ai", hostOnly: true };
  }
  if (name.startsWith("__client_uat")) {
    return { domain: ".venice.ai", hostOnly: false };
  }
  if (name.startsWith("__session")) {
    return { domain: "venice.ai", hostOnly: true };
  }
  if (name === "__cf_bm" || name === "_cfuvid") {
    return { domain: "clerk.venice.ai", hostOnly: true };
  }
  return { domain: ".venice.ai", hostOnly: false };
}

function withDomain(cookie) {
  if (cookie.domain) {
    return {
      ...cookie,
      hostOnly:
        typeof cookie.hostOnly === "boolean" ? cookie.hostOnly : !cookie.domain.startsWith("."),
    };
  }
  return { ...cookie, ...inferDomain(cookie.name) };
}

function expiresAtFrom(item) {
  const seconds = item.expirationDate ?? item.expires;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    // Cookie-Editor/EditThisCookie use seconds; some exports already use ms.
    return seconds > 1e12 ? Math.round(seconds) : Math.round(seconds * 1000);
  }
  if (typeof item.expiresAt === "number" && Number.isFinite(item.expiresAt) && item.expiresAt > 0) {
    return Math.round(item.expiresAt);
  }
  return null;
}

function normalizeJsonCookie(item) {
  if (!item || typeof item.name !== "string" || typeof item.value !== "string") {
    return null;
  }
  const name = item.name.trim();
  if (!name || item.value === "") {
    return null;
  }
  return withDomain({
    name,
    value: item.value,
    domain: typeof item.domain === "string" ? item.domain.trim() : "",
    path: typeof item.path === "string" && item.path ? item.path : "/",
    secure: Boolean(item.secure),
    httpOnly: Boolean(item.httpOnly),
    hostOnly: typeof item.hostOnly === "boolean" ? item.hostOnly : undefined,
    expiresAt: expiresAtFrom(item),
  });
}

function parseCookieHeader(text) {
  const cookies = [];
  for (const part of text.split(/;\s*/)) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || COOKIE_ATTRIBUTES.has(name.toLowerCase())) {
      continue;
    }
    cookies.push(
      withDomain({
        name,
        value,
        domain: "",
        path: "/",
        secure: false,
        httpOnly: false,
      }),
    );
  }
  return cookies;
}

function parseNetscape(text) {
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const fields = trimmed.split("\t");
    if (fields.length < 7) {
      continue;
    }
    const [domain, , cookiePath, secure, expires, name, ...rest] = fields;
    const value = rest.join("\t");
    if (!name || !value) {
      continue;
    }
    const expiresSeconds = Number(expires);
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || "/",
      secure: secure.toUpperCase() === "TRUE",
      httpOnly: false,
      hostOnly: !domain.startsWith("."),
      expiresAt:
        Number.isFinite(expiresSeconds) && expiresSeconds > 0
          ? Math.round(expiresSeconds * 1000)
          : null,
    });
  }
  return cookies;
}

// Accepts four shapes, because that is what people actually paste:
//  1. a Cookie-Editor/EditThisCookie JSON export (or this project's own snapshot)
//  2. a Netscape cookies.txt block
//  3. a `Cookie:` header: `__client=...; __client_uat=...`
//  4. the bare `__client` value
export function parseCookieInput(input) {
  const text = String(input ?? "").trim();
  if (!text) {
    return [];
  }

  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A truncated JSON export is a bad paste, not a cookie value.
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.cookies)
        ? parsed.cookies
        : [];
    return list.map(normalizeJsonCookie).filter(Boolean).filter(hasVeniceDomain);
  }

  if (text.includes("\t")) {
    return parseNetscape(text).filter(hasVeniceDomain);
  }

  if (text.includes("=") || text.includes(";")) {
    return parseCookieHeader(text).filter(hasVeniceDomain);
  }

  return [
    toSessionCookie({
      name: "__client",
      value: text,
      domain: "clerk.venice.ai",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: -1,
    }),
  ];
}

function hasVeniceDomain(cookie) {
  return isVeniceCookieDomain(cookie.domain);
}

export function cookieInputHint() {
  return [
    "Sign in at https://venice.ai with Google in any browser.",
    "Then open DevTools > Application > Cookies > https://clerk.venice.ai and copy the __client value.",
    "You can paste that value, a `__client=...` header, a Cookie-Editor JSON export, or a Netscape cookies.txt.",
  ].join("\n");
}

export async function loginWithCookies({ sessionFile, text }) {
  const cookies = parseCookieInput(text);
  if (cookies.length === 0) {
    throw new Error(`No Venice cookies were found in the pasted value.\n${cookieInputHint()}`);
  }
  if (!cookies.some((cookie) => cookie.name === "__client")) {
    throw new Error(
      `The __client cookie is required to restore a Clerk session.\n${cookieInputHint()}`,
    );
  }

  const client = new VeniceWebClient({
    sessionFile: sessionFile || path.resolve(process.cwd(), ".venice-web-session.json"),
  });
  try {
    return await saveCapturedSession({
      client,
      cookies,
      loginMethod: "cookie-import",
    });
  } finally {
    await client.close();
  }
}