import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VeniceWebClient } from "../src/client.mjs";

// Interactive Google (OAuth) login for accounts that have no Venice password.
//
// Clerk only lets the browser finish the Google handshake, so this launches a
// real Chrome/Edge window, waits until the Venice page reports an active Clerk
// session, and then captures the session token and Venice/Clerk cookies. The
// rest of the login (user session lookup, snapshot file) reuses the same
// VeniceWebClient path as the password flow.
//
// The browser profile is persistent (unlike a throwaway temp dir), so the Google
// account and Venice cookies are remembered between runs. The first run needs a
// real Google sign-in; later runs usually finish without any interaction.
//
// It cannot reuse the normal Chrome profile: Chrome 136+ refuses to open a
// DevTools port on the default user-data-dir, a running Chrome cannot share its
// profile, and copying the profile does not work either because Chrome encrypts
// every cookie value with an App-Bound key (Chrome 127+) that only the original
// profile can use. A persistent dedicated profile is the supported middle ground.

const VENICE_ORIGIN = "https://venice.ai";
const SIGN_IN_URL = `${VENICE_ORIGIN}/sign-in`;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_POLL_MS = 700;
const COOKIE_DOMAIN_RE = /(^|\.)(venice\.ai|clerkprod-cloudflare\.net)$/i;
const PROFILE_DIR_NAME = ".venice-google-profile";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutFromEnv() {
  const configured = Number(process.env.VENICE_GOOGLE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

// A stable profile is what makes the Google login survive between runs. Point
// VENICE_GOOGLE_PROFILE_DIR somewhere else to share one profile between checkouts
// or to keep it out of the home directory.
export function resolveProfileDir() {
  const configured = process.env.VENICE_GOOGLE_PROFILE_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), PROFILE_DIR_NAME);
}

function chromeCandidates() {
  const configured = process.env.VENICE_CHROME_PATH?.trim();
  if (configured) {
    return [configured];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    return [
      ...roots.map((root) =>
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      ),
      ...roots.map((root) =>
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      ),
    ];
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
    "/usr/bin/microsoft-edge",
  ];
}

export function findBrowserExecutable() {
  for (const candidate of chromeCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore unreadable candidates
    }
  }
  return null;
}

// Map a Chrome DevTools cookie to the shape CookieJar stores, so a session
// captured in the browser can be restored with wreq exactly like a login.
export function toSessionCookie(cookie) {
  if (
    !cookie ||
    typeof cookie.name !== "string" ||
    typeof cookie.value !== "string" ||
    typeof cookie.domain !== "string" ||
    !cookie.domain
  ) {
    return null;
  }

  const domain = cookie.domain;
  const expires = Number(cookie.expires);
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: typeof cookie.path === "string" && cookie.path ? cookie.path : "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: !domain.startsWith("."),
    expiresAt: Number.isFinite(expires) && expires > 0 ? Math.round(expires * 1000) : null,
  };
}

export function extractVeniceCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => COOKIE_DOMAIN_RE.test(String(cookie?.domain ?? "")))
    .map(toSessionCookie)
    .filter(Boolean);
}

class CdpConnection {
  static async connect(url, timeoutMs = 20_000) {
    if (typeof globalThis.WebSocket !== "function") {
      throw new Error(
        "This Node.js build has no global WebSocket. Use Node.js 22.4 or newer for --google login.",
      );
    }

    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to Chrome at ${url}.`)),
        timeoutMs,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to Chrome DevTools: ${event?.message ?? "unknown error"}`));
      };
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;

    socket.onmessage = (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message?.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result);
      }
    };
    socket.onclose = () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error("Chrome DevTools connection closed."));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}, sessionId = null) {
    if (this.closed) {
      return Promise.reject(new Error("Chrome DevTools connection closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  async evaluate(sessionId, expression) {
    const response = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (response?.exceptionDetails) {
      return null;
    }
    return response?.result?.value ?? null;
  }

  async pageTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return (targetInfos || []).filter((target) => target.type === "page");
  }

  async attach(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    return sessionId;
  }

  async cookies() {
    const { cookies } = await this.send("Storage.getCookies");
    return cookies || [];
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
    this.closed = true;
  }
}

async function launchBrowser(executable, userDataDir) {
  const child = spawn(
    executable,
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--disable-background-networking",
      "--disable-sync",
      SIGN_IN_URL,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  let wsUrl = null;

  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Chrome did not expose a DevTools endpoint in time.${stderr ? `\n${stderr.slice(-2000)}` : ""}`));
    }, 20_000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match && !wsUrl) {
        wsUrl = match[1];
        clearTimeout(timer);
        resolve(wsUrl);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not launch ${executable}: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (wsUrl) {
        return;
      }
      clearTimeout(timer);
      reject(
        new Error(
          `Browser exited before the DevTools endpoint was ready (code ${code}).${stderr ? `\n${stderr.slice(-2000)}` : ""}`,
        ),
      );
    });
  });

  try {
    return { child, wsUrl: await connected };
  } catch (error) {
    try {
      child.kill();
    } catch {
      // ignore
    }
    throw error;
  }
}

export function cookieSignalsLogin(cookies) {
  const clientUat = cookies.find((cookie) => cookie.name === "__client_uat");
  if (clientUat) {
    const value = String(clientUat.value || "").trim();
    return value !== "" && value !== "0";
  }
  return false;
}

export async function readBrowserSession(cdp, sessions) {
  for (const target of await cdp.pageTargets()) {
    if (!sessions.has(target.targetId)) {
      try {
        sessions.set(target.targetId, await cdp.attach(target.targetId));
      } catch {
        continue;
      }
    }
  }

  for (const sessionId of sessions.values()) {
    const state = await cdp.evaluate(
      sessionId,
      `(() => {
        const clerk = window.Clerk;
        if (!clerk) return { clerk: false };
        const session = clerk.session;
        if (!session || !session.id) return { clerk: true, session: null };
        const user = session.user || clerk.user || null;
        return {
          clerk: true,
          sessionId: session.id,
          userId: user && user.id ? user.id : null,
          email: user && user.primaryEmailAddress
            ? user.primaryEmailAddress.emailAddress
            : null,
        };
      })()`,
    ).catch(() => null);

    if (state?.sessionId) {
      let token = null;
      try {
        token = await cdp.evaluate(
          sessionId,
          `(async () => {
            try {
              return await window.Clerk.session.getToken({ skipCache: true });
            } catch {
              return null;
            }
          })()`,
        );
      } catch {
        token = null;
      }
      return {
        sessionId: state.sessionId,
        userId: state.userId ?? null,
        email: state.email ?? null,
        token: typeof token === "string" && token ? token : null,
      };
    }
  }

  return null;
}

async function saveGoogleSession({ client, cookies, browserSession }) {
  client.cookies.import(cookies);
  client.wreqSeeded = false;

  let restored = null;
  try {
    restored = await client.restoreSessionFromCookies();
  } catch (error) {
    if (!browserSession?.token || !browserSession?.sessionId) {
      throw error;
    }
    console.warn(
      `[login:google] cookie restore failed (${error.message}); using the session token captured from the browser.`,
    );
  }

  const clerkJwt = restored?.clerkJwt || browserSession?.token;
  const sessionId = restored?.sessionId || browserSession?.sessionId;
  if (!clerkJwt || !sessionId) {
    throw new Error("Google sign-in finished but no Clerk session could be captured.");
  }

  client.sessionId = sessionId;
  client.clerkJwt = clerkJwt;

  let userSession = null;
  try {
    userSession = await client.getUserSession(clerkJwt);
  } catch (error) {
    console.warn(
      `[login:google] could not verify the session against outerface (${error.message}); keeping the captured session.`,
    );
  }

  const email = userSession?.email || browserSession?.email || client.email || null;
  if (email) {
    client.email = email;
  }
  client.userId =
    userSession?.userId ||
    userSession?.authSystemUserId ||
    browserSession?.userId ||
    client.userId ||
    null;
  client.userDistinctId =
    userSession?.id || userSession?.user?.id || client.userDistinctId || crypto.randomUUID();

  client.writeSavedSession({
    loginMethod: "google",
    lastValidatedAt: Date.now(),
  });

  return {
    ok: true,
    source: "google",
    sessionFile: client.sessionFile,
    email,
    sessionId,
    userId: client.userId,
    clerkJwtPreview: `${clerkJwt.slice(0, 24)}...`,
    hasOuterfaceToken: Boolean(userSession?.token),
    canPost: userSession?.canPost,
  };
}

export async function loginWithGoogle({ sessionFile, timeoutMs, freshProfile = false } = {}) {
  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error(
      "Chrome, Edge or Chromium was not found for Google sign-in. Install one, or set VENICE_CHROME_PATH to its executable.",
    );
  }

  const profileDir = resolveProfileDir();
  const waitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : timeoutFromEnv();
  const targetFile = sessionFile || ".venice-web-session.json";

  if (freshProfile) {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  const isNewProfile = !fs.existsSync(profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  console.error(`[login:google] opening ${path.basename(executable)} at ${SIGN_IN_URL}`);
  console.error(`[login:google] browser profile: ${profileDir}`);
  console.error(
    isNewProfile
      ? `[login:google] first run: sign in to Google once in that window; the profile is kept for next time. Waiting up to ${Math.round(waitMs / 1000)}s.`
      : `[login:google] reusing the saved profile; if the current session is still valid this finishes on its own. Waiting up to ${Math.round(waitMs / 1000)}s.`,
  );

  const { child, wsUrl } = await launchBrowser(executable, profileDir);
  const cdp = await CdpConnection.connect(wsUrl);
  const sessions = new Map();

  try {
    const deadline = Date.now() + waitMs;
    let browserSession = null;
    let signedInCookies = null;

    while (Date.now() < deadline) {
      try {
        browserSession = await readBrowserSession(cdp, sessions);
        if (browserSession) {
          signedInCookies = await cdp.cookies();
          break;
        }

        const cookies = await cdp.cookies().catch(() => []);
        if (cookieSignalsLogin(cookies)) {
          signedInCookies = cookies;
          browserSession = null;
          break;
        }
      } catch (error) {
        throw new Error(
          `Google sign-in window closed or became unreachable before the session was captured (${error.message}).`,
        );
      }

      await sleep(SESSION_POLL_MS);
    }

    if (!signedInCookies) {
      throw new Error(
        `Google sign-in did not complete within ${Math.round(waitMs / 1000)}s. Re-run the login and finish the Google flow in the opened window. Profile: ${profileDir}. If the window could not open, the profile may still be locked by another Chrome; close it or re-run with --fresh-profile.`,
      );
    }

    // Let Clerk finish writing its cookies before the browser is closed.
    await sleep(500);
    signedInCookies = await cdp.cookies().catch(() => signedInCookies);

    const cookies = extractVeniceCookies(signedInCookies);
    if (cookies.length === 0) {
      throw new Error("Google sign-in finished but no Venice cookies were captured.");
    }

    const client = new VeniceWebClient({ sessionFile: targetFile });
    try {
      const result = await saveGoogleSession({ client, cookies, browserSession });
      return { ...result, profileDir };
    } finally {
      await client.close();
    }
  } finally {
    try {
      await cdp.send("Browser.close");
    } catch {
      // ignore: the user may have closed the window already
    }
    cdp.close();
    try {
      child.kill();
    } catch {
      // ignore
    }
    // Give Chrome a moment to flush the profile (cookies included) before the
    // caller reports the saved session. The profile itself stays on disk.
    await sleep(300);
  }
}