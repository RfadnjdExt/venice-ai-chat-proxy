import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cookieSignalsLogin,
  extractVeniceCookies,
  findBrowserExecutable,
  readBrowserSession,
  toSessionCookie,
} from "../scripts/login-google.mjs";
import { VeniceWebClient } from "../src/client.mjs";

let passed = 0;
let failed = 0;

function ok(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

function testCookieMapping() {
  section("toSessionCookie");
  const mapped = toSessionCookie({
    name: "__client",
    value: "token",
    domain: "clerk.venice.ai",
    path: "/",
    expires: 1794295192.5,
    secure: true,
    httpOnly: true,
  });
  ok("maps name and value", mapped.name === "__client" && mapped.value === "token");
  ok("keeps the host domain", mapped.domain === "clerk.venice.ai");
  ok("hostOnly when the domain has no leading dot", mapped.hostOnly === true);
  ok("converts expires seconds to milliseconds", mapped.expiresAt === 1794295192500);
  ok("keeps secure and httpOnly flags", mapped.secure === true && mapped.httpOnly === true);

  const shared = toSessionCookie({
    name: "__client_uat",
    value: "1794295192",
    domain: ".venice.ai",
    path: "/",
    expires: -1,
    secure: false,
    httpOnly: false,
  });
  ok("shared domain is not hostOnly", shared.hostOnly === false);
  ok("session cookie has no expiresAt", shared.expiresAt === null);
  ok("defaults the path to /", toSessionCookie({ name: "a", value: "b", domain: "venice.ai" }).path === "/");

  ok("rejects a cookie without a name", toSessionCookie({ value: "b", domain: "venice.ai" }) === null);
  ok("rejects a cookie without a domain", toSessionCookie({ name: "a", value: "b" }) === null);
}

function testCookieFiltering() {
  section("extractVeniceCookies");
  const cookies = [
    { name: "__client", value: "a", domain: "clerk.venice.ai", path: "/", expires: -1 },
    { name: "__client_uat", value: "1", domain: ".venice.ai", path: "/", expires: -1 },
    { name: "_cfuvid", value: "b", domain: "venice.ai", path: "/", expires: -1 },
    { name: "_cfuvid", value: "c", domain: ".clerkprod-cloudflare.net", path: "/", expires: -1 },
    { name: "NID", value: "d", domain: ".google.com", path: "/", expires: -1 },
    { name: "SID", value: "e", domain: "accounts.google.com", path: "/", expires: -1 },
    { name: "spoof", value: "f", domain: "evilvenice.ai", path: "/", expires: -1 },
  ];
  const filtered = extractVeniceCookies(cookies);
  ok("keeps clerk.venice.ai", filtered.some((cookie) => cookie.domain === "clerk.venice.ai"));
  ok("keeps .venice.ai", filtered.some((cookie) => cookie.domain === ".venice.ai"));
  ok("keeps venice.ai", filtered.some((cookie) => cookie.domain === "venice.ai"));
  ok(
    "keeps the Clerk Cloudflare domain",
    filtered.some((cookie) => cookie.domain === ".clerkprod-cloudflare.net"),
  );
  ok("drops Google cookies", !filtered.some((cookie) => /google\.com$/.test(cookie.domain)));
  ok("drops look-alike domains", !filtered.some((cookie) => cookie.domain === "evilvenice.ai"));
  ok("drops malformed entries", extractVeniceCookies([null, { name: "x" }]).length === 0);
  ok("tolerates a non-array", extractVeniceCookies(null).length === 0);
}

function testBrowserDiscovery() {
  section("findBrowserExecutable");
  const previous = process.env.VENICE_CHROME_PATH;
  try {
    process.env.VENICE_CHROME_PATH = process.execPath;
    ok("uses VENICE_CHROME_PATH when it exists", findBrowserExecutable() === process.execPath);

    process.env.VENICE_CHROME_PATH = `${process.execPath}.missing`;
    const found = findBrowserExecutable();
    ok(
      "falls back to a detected browser when the override is missing",
      found === null || found !== process.env.VENICE_CHROME_PATH,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.VENICE_CHROME_PATH;
    } else {
      process.env.VENICE_CHROME_PATH = previous;
    }
  }
}

function testCookieSignal() {
  section("cookieSignalsLogin");
  ok("missing __client_uat is not signed in", !cookieSignalsLogin([]));
  ok("__client_uat=0 is not signed in", !cookieSignalsLogin([{ name: "__client_uat", value: "0" }]));
  ok(
    "a timestamp __client_uat is signed in",
    cookieSignalsLogin([{ name: "__client_uat", value: "1794295192" }]),
  );
  ok("blank __client_uat is not signed in", !cookieSignalsLogin([{ name: "__client_uat", value: " " }]));
}

function testEmailCapture() {
  section("email capture and snapshot persistence");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-google-check-"));
  const file = path.join(dir, "session.json");
  try {
    const client = new VeniceWebClient({ sessionFile: file });
    const extracted = client.extractClerkSession({
      response: {
        sessions: [
          {
            id: "sess_1",
            status: "active",
            last_active_token: { jwt: "jwt" },
            user: {
              id: "user_1",
              primary_email_address_id: "email_2",
              email_addresses: [
                { id: "email_1", email_address: "old@example.com" },
                { id: "email_2", email_address: "primary@example.com" },
              ],
            },
          },
        ],
      },
    });
    ok("extracts the primary email from Clerk", extracted?.email === "primary@example.com");
    ok("extracts the user id", extracted?.userId === "user_1");
    ok("extracts the session id", extracted?.sessionId === "sess_1");

    fs.writeFileSync(
      file,
      JSON.stringify({
        email: "saved@example.com",
        sessionId: "sess_1",
        clerkJwt: "a.b.c",
        cookies: [],
      }),
    );
    const savedClient = new VeniceWebClient({ sessionFile: file });
    savedClient.restoreSavedSession(savedClient.readSavedSession());
    ok("restore keeps the saved email", savedClient.email === "saved@example.com");
    savedClient.writeSavedSession({ lastValidatedAt: Date.now() });
    ok(
      "rewriting the snapshot keeps the email",
      JSON.parse(fs.readFileSync(file, "utf8")).email === "saved@example.com",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testBrowserSessionDetection() {
  section("readBrowserSession");

  const makeCdp = (targets, evaluateImpl) => ({
    attached: [],
    async pageTargets() {
      return targets;
    },
    async attach(targetId) {
      this.attached.push(targetId);
      return `session-${targetId}`;
    },
    async evaluate(sessionId, expression) {
      return await evaluateImpl(sessionId, expression);
    },
  });

  const signedIn = await readBrowserSession(
    makeCdp([{ targetId: "T1", type: "page" }], async (_sessionId, expression) =>
      expression.includes("getToken")
        ? "jwt.header.payload"
        : { clerk: true, sessionId: "sess_1", userId: "user_1", email: "me@example.com" },
    ),
    new Map(),
  );
  ok("detects the active Clerk session", signedIn?.sessionId === "sess_1");
  ok("carries the browser user id", signedIn?.userId === "user_1");
  ok("carries the browser email", signedIn?.email === "me@example.com");
  ok("captures the session token", signedIn?.token === "jwt.header.payload");

  const tokenless = await readBrowserSession(
    makeCdp([{ targetId: "T1", type: "page" }], async (_sessionId, expression) =>
      expression.includes("getToken")
        ? null
        : { clerk: true, sessionId: "sess_2", userId: null, email: null },
    ),
    new Map(),
  );
  ok("a session without a token is still usable", tokenless?.sessionId === "sess_2" && tokenless?.token === null);

  const attached = [];
  const secondPage = await readBrowserSession(
    makeCdp(
      [
        { targetId: "T1", type: "page" },
        { targetId: "T2", type: "page" },
      ],
      async (sessionId, expression) => {
        attached.push(sessionId);
        if (expression.includes("getToken")) {
          return "jwt.second";
        }
        return sessionId === "session-T2"
          ? { clerk: true, sessionId: "sess_popup", userId: "u2", email: null }
          : { clerk: true, session: null };
      },
    ),
    new Map(),
  );
  ok("a second page (popup) is checked too", secondPage?.sessionId === "sess_popup");
  ok("every page is attached once", attached.includes("session-T1") && attached.includes("session-T2"));

  const none = await readBrowserSession(
    makeCdp([], async () => null),
    new Map(),
  );
  ok("no pages means no session", none === null);

  const sessions = new Map();
  const cdp = makeCdp([{ targetId: "T1", type: "page" }], async (_sessionId, expression) =>
    expression.includes("getToken")
      ? "jwt"
      : { clerk: true, sessionId: "sess_cached", userId: null, email: null },
  );
  await readBrowserSession(cdp, sessions);
  await readBrowserSession(cdp, sessions);
  ok("a page is attached only once across polls", cdp.attached.length === 1);
}

function main() {
  testCookieMapping();
  testCookieFiltering();
  testCookieSignal();
  testBrowserDiscovery();
  testEmailCapture();
  testBrowserSessionDetection()
    .then(() => {
      console.log(`\n────────────────────────────────────────\nResults: ${passed} passed, ${failed} failed\n`);
      if (failed > 0) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

main();