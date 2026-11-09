import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cookieInputHint,
  loginWithCookies,
  parseCookieInput,
} from "../scripts/login-cookies.mjs";
import { isVeniceCookieDomain } from "../scripts/login-google.mjs";

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

function testBareValue() {
  section("bare __client value");
  const cookies = parseCookieInput("eyJhbGciOi.payload.sig");
  ok("produces one cookie", cookies.length === 1);
  ok("names it __client", cookies[0].name === "__client");
  ok("keeps the value intact", cookies[0].value === "eyJhbGciOi.payload.sig");
  ok("targets clerk.venice.ai", cookies[0].domain === "clerk.venice.ai");
  ok("is host-only", cookies[0].hostOnly === true);
  ok("is secure and httpOnly", cookies[0].secure === true && cookies[0].httpOnly === true);
  ok("has no expiry (session cookie)", cookies[0].expiresAt === null);
}

function testCookieHeader() {
  section("Cookie header");
  const cookies = parseCookieInput("__client=abc; __client_uat=1794295192");
  ok("parses both pairs", cookies.length === 2);
  const client = cookies.find((cookie) => cookie.name === "__client");
  const uat = cookies.find((cookie) => cookie.name === "__client_uat");
  ok("__client goes to clerk.venice.ai", client?.domain === "clerk.venice.ai");
  ok("__client_uat goes to .venice.ai", uat?.domain === ".venice.ai");
  ok("__client_uat is a domain cookie", uat?.hostOnly === false);

  const withAttributes = parseCookieInput("__client=abc; path=/; domain=.venice.ai; secure");
  ok("drops cookie attributes", withAttributes.length === 1);
  ok("keeps only the real cookie", withAttributes[0].name === "__client");

  const padded = parseCookieInput("__client=abc==; other=1");
  ok("keeps = characters inside the value", padded[0].value === "abc==");
}

function testJsonExport() {
  section("Cookie-Editor JSON");
  const exported = JSON.stringify([
    {
      domain: ".clerk.venice.ai",
      hostOnly: false,
      httpOnly: true,
      name: "__client",
      path: "/",
      secure: true,
      session: false,
      value: "abc",
      expirationDate: 1794295192.5,
    },
    {
      domain: ".venice.ai",
      hostOnly: false,
      httpOnly: false,
      name: "__client_uat",
      path: "/",
      secure: true,
      session: true,
      value: "1794295192",
    },
    {
      domain: ".google.com",
      name: "SID",
      path: "/",
      value: "x",
    },
  ]);
  const cookies = parseCookieInput(exported);
  ok("drops foreign domains", cookies.length === 2);
  ok("keeps the Clerk domain", cookies.some((cookie) => cookie.domain === ".clerk.venice.ai"));
  ok(
    "converts expirationDate seconds to ms",
    cookies.find((cookie) => cookie.name === "__client")?.expiresAt === 1794295192500,
  );
  ok(
    "session cookies have no expiry",
    cookies.find((cookie) => cookie.name === "__client_uat")?.expiresAt === null,
  );
  ok("keeps a leading-dot domain shared", cookies[0].hostOnly === false);

  const snapshot = JSON.stringify({
    cookies: [
      { name: "__client", value: "abc", domain: "clerk.venice.ai", path: "/", expiresAt: 1794295192500 },
    ],
  });
  const fromSnapshot = parseCookieInput(snapshot);
  ok("reads this project's own snapshot shape", fromSnapshot.length === 1);
  ok("keeps ms expiry as-is", fromSnapshot[0].expiresAt === 1794295192500);

  ok("ignores JSON without a cookie list", parseCookieInput('{"foo":1}').length === 0);
}

function testNetscape() {
  section("Netscape cookies.txt");
  const text = [
    "# Netscape HTTP Cookie File",
    ".clerk.venice.ai\tTRUE\t/\tTRUE\t1794295192\t__client\tabc",
    ".venice.ai\tTRUE\t/\tFALSE\t0\t__client_uat\t1794295192",
    ".google.com\tTRUE\t/\tTRUE\t1794295192\tSID\txyz",
  ].join("\n");
  const cookies = parseCookieInput(text);
  ok("drops foreign domains", cookies.length === 2);
  ok("parses the __client row", cookies[0].name === "__client" && cookies[0].value === "abc");
  ok("marks shared domains as not host-only", cookies[0].hostOnly === false);
  ok("marks secure rows", cookies[0].secure === true);
  ok("converts expiry seconds to ms", cookies[0].expiresAt === 1794295192000);
  ok("treats expiry 0 as a session cookie", cookies[1].expiresAt === null);
}

function testEdgeCases() {
  section("edge cases");
  ok("empty input is empty", parseCookieInput("").length === 0);
  ok("whitespace input is empty", parseCookieInput("   \n ").length === 0);
  ok("null input is empty", parseCookieInput(null).length === 0);
  ok("bad JSON falls back to header parsing", parseCookieInput("{not json").length === 0);
  ok("a header without cookies is empty", parseCookieInput("; ; ").length === 0);
  ok("domain matching accepts venice.ai", isVeniceCookieDomain("venice.ai"));
  ok("domain matching accepts .clerk.venice.ai", isVeniceCookieDomain(".clerk.venice.ai"));
  ok("domain matching rejects look-alikes", !isVeniceCookieDomain("evilvenice.ai"));
  ok("the hint mentions __client", cookieInputHint().includes("__client"));
}

async function testMissingClientCookie() {
  section("loginWithCookies validation");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-cookie-check-"));
  try {
    let message = "";
    try {
      await loginWithCookies({
        sessionFile: path.join(dir, "session.json"),
        text: "__client_uat=1794295192",
      });
    } catch (error) {
      message = error.message;
    }
    ok("rejects input without __client", message.includes("__client"));

    let emptyMessage = "";
    try {
      await loginWithCookies({ sessionFile: path.join(dir, "session.json"), text: "" });
    } catch (error) {
      emptyMessage = error.message;
    }
    ok("rejects empty input", emptyMessage.includes("No Venice cookies"));
    ok("writes no session file on failure", !fs.existsSync(path.join(dir, "session.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testBareValue();
  testCookieHeader();
  testJsonExport();
  testNetscape();
  testEdgeCases();
  await testMissingClientCookie();

  console.log(`\n────────────────────────────────────────\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();