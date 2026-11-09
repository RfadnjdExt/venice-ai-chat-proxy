import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVeniceOpenAiProxy, discoverSessionFiles, isRateLimitError, parseAccountRefreshInterval, parseRateLimitCooldown, VeniceAccount } from "../src/proxy.mjs";

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

function testRateLimitHelper() {
  section("isRateLimitError & parseRateLimitCooldown");
  const err429 = new Error('HTTP 429: {"error":"Rate limit exceeded"}');
  err429.status = 429;
  ok("identifies HTTP 429 error", isRateLimitError(err429));

  const overloadErr = new Error('HTTP 429: {"error":"modelOverloaded"}');
  ok("modelOverloaded is not account rate limit", !isRateLimitError(overloadErr));

  const otherErr = new Error("HTTP 500: Server Error");
  ok("other error is not rate limit", !isRateLimitError(otherErr));

  const withHeader = new Error("HTTP 429: Rate limit exceeded");
  withHeader.rateLimitReset = "1794295192824";
  const cooldown = parseRateLimitCooldown(withHeader);
  ok("parses ms reset header", cooldown === 1794295192824);

  const defaultCooldown = parseRateLimitCooldown(err429);
  ok("falls back to ~1hr cooldown", defaultCooldown > Date.now() + 3500_000);
}

async function testPoolRotationAndFailover() {
  section("Account pool rotation and failover");

  const accFiles = ["session-a.json", "session-b.json"];
  const proxy = createVeniceOpenAiProxy(accFiles);

  ok("proxy loaded 2 accounts", proxy.accounts.length === 2);
  ok("account A has correct file", proxy.accounts[0].sessionFile.endsWith("session-a.json"));
  ok("account B has correct file", proxy.accounts[1].sessionFile.endsWith("session-b.json"));

  // Mock ensureAuth on both accounts
  for (const acc of proxy.accounts) {
    acc.ensureAuth = async () => ({ login: { clerkJwt: `jwt-${acc.sessionFile}` } });
  }

  const calls = [];
  proxy.accounts[0].client.chat = async () => {
    calls.push("acc-a");
    return { text: "from A", events: [] };
  };
  proxy.accounts[1].client.chat = async () => {
    calls.push("acc-b");
    return { text: "from B", events: [] };
  };

  // Request 1: should use account A
  const res1 = await proxy.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
  ok("request 1 succeeds from A", res1.text === "from A" && calls[0] === "acc-a");

  // Request 2: should rotate to account B
  const res2 = await proxy.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
  ok("request 2 rotates to B", res2.text === "from B" && calls[1] === "acc-b");

  // Test 429 failover: Next in line is Account A. Set Account A to throw 429.
  proxy.accounts[0].client.chat = async () => {
    calls.push("acc-a-fail");
    const err = new Error('HTTP 429: {"error":"Rate limit exceeded"}');
    err.status = 429;
    throw err;
  };

  // Request 3: Account A fails with 429, should automatically failover to B
  const res3 = await proxy.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
  ok("request 3 failover to B", res3.text === "from B");
  ok("account A marked rate-limited", proxy.accounts[0].isRateLimited());

  // Request 4: Next request should skip rate-limited A and go directly to B
  calls.length = 0;
  const res4 = await proxy.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
  ok("request 4 skips rate-limited A", calls[0] === "acc-b" && res4.text === "from B");

  // Test all accounts rate-limited
  proxy.accounts[1].client.chat = async () => {
    const err = new Error('HTTP 429: {"error":"Rate limit exceeded"}');
    err.status = 429;
    throw err;
  };

  let caught = null;
  try {
    await proxy.chatCompletions({ messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    caught = e;
  }
  ok("throws when all accounts are rate-limited", caught && isRateLimitError(caught));
  ok("error message notes all accounts exceeded", caught?.message?.includes("all 2 accounts"));
}

async function testAccountHotReload() {
  section("Live account hot-reload");

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-hot-reload-"));
  const file = (name) => path.join(dir, name);
  const account = (name) => {
    const target = file(name);
    fs.writeFileSync(target, JSON.stringify({ sessionId: `session-${name}` }));
    return target;
  };

  try {
    const a = account("session-a.json");
    const b = account("session-b.json");
    const c = account("session-c.json");

    ok("refresh interval defaults to 3000ms", parseAccountRefreshInterval(undefined) === 3000);
    ok("refresh interval can be disabled", parseAccountRefreshInterval("0") === 0);
    ok("refresh interval honours a custom value", parseAccountRefreshInterval("1500") === 1500);

    const proxy = createVeniceOpenAiProxy([a, b]);
    const accountA = proxy.accounts[0];
    const accountB = proxy.accounts[1];
    proxy.accountIndex = 1; // next request would use B
    proxy.currentAccount = accountA;

    const added = proxy.syncAccounts([a, b, c]);
    ok("a new complete session file joins the pool", proxy.accounts.length === 3 && added.added.includes(c));
    ok("existing account objects are reused", proxy.accounts[0] === accountA && proxy.accounts[1] === accountB);
    ok("new account is appended in its discovered position", proxy.accounts[2].sessionFile === c);
    ok("rotation pointer still targets the same account", proxy.accounts[proxy.accountIndex] === accountB);
    ok("current account is preserved", proxy.currentAccount === accountA);

    const halfWritten = file("session-d.json");
    fs.writeFileSync(halfWritten, '{"sessionId":');
    const keyless = file("session-e.json");
    fs.writeFileSync(keyless, "{}");
    const ignored = proxy.syncAccounts([a, b, c, halfWritten, keyless]);
    ok("half-written login file is not added", !proxy.accounts.some((acc) => acc.sessionFile === halfWritten));
    ok("session file without a token is not added", !proxy.accounts.some((acc) => acc.sessionFile === keyless));
    ok("unready files report no additions", ignored.added.length === 0 && ignored.removed.length === 0);

    // An existing file that cannot be read for a moment keeps the account (and
    // its cached auth) instead of being dropped and re-added.
    const savedA = fs.readFileSync(a, "utf8");
    fs.writeFileSync(a, '{"sessionId":');
    proxy.syncAccounts([a, b, c]);
    ok("a momentarily unreadable file keeps its account", proxy.accounts.length === 3);
    ok("a momentarily unreadable file keeps account identity", proxy.accounts[0] === accountA);
    fs.writeFileSync(a, savedA);

    const removed = proxy.syncAccounts([a, c]);
    ok("a deleted session file leaves the pool", proxy.accounts.length === 2 && removed.removed.includes(b));
    ok("remaining accounts keep their identity", proxy.accounts[0] === accountA);
    ok("current account survives a removal elsewhere", proxy.currentAccount === accountA);

    const empty = proxy.syncAccounts([halfWritten]);
    ok("an empty ready set does not wipe the pool", proxy.accounts.length === 2 && empty.added.length === 0);

    // The watcher picks up an added file on its own and stops cleanly. Discovery
    // scans the cwd, so the test runs inside its own temp directory.
    const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-hot-watch-"));
    const watchA = path.join(watchDir, ".venice-web-session.json");
    fs.writeFileSync(watchA, JSON.stringify({ sessionId: "watch-a" }));
    const originCwd = process.cwd();
    const previousSessionFile = process.env.VENICE_SESSION_FILE;
    const previousSessionFiles = process.env.VENICE_SESSION_FILES;
    let watched = null;
    try {
      delete process.env.VENICE_SESSION_FILE;
      delete process.env.VENICE_SESSION_FILES;
      process.chdir(watchDir);
      watched = createVeniceOpenAiProxy();
      ok("watcher test starts with one account", watched.accounts.length === 1);
      ok("watcher starts", Boolean(watched.watchAccounts(20)));
      ok("watcher is exposed on the proxy", Boolean(watched.accountWatcher));

      fs.writeFileSync(
        path.join(watchDir, ".venice-web-session-2.json"),
        JSON.stringify({ sessionId: "watch-b" }),
      );
      await delay(120);
      ok("watcher adds a new account without a restart", watched.accounts.length === 2);

      watched.stopAccountWatcher();
      ok("watcher stops", watched.accountWatcher === null);
      fs.writeFileSync(
        path.join(watchDir, ".venice-web-session-3.json"),
        JSON.stringify({ sessionId: "watch-c" }),
      );
      await delay(80);
      ok("stopped watcher leaves the pool alone", watched.accounts.length === 2);

      ok("watch interval 0 does not start a watcher", watched.watchAccounts(0) === null);
    } finally {
      watched?.stopAccountWatcher();
      process.chdir(originCwd);
      if (previousSessionFile === undefined) {
        delete process.env.VENICE_SESSION_FILE;
      } else {
        process.env.VENICE_SESSION_FILE = previousSessionFile;
      }
      if (previousSessionFiles === undefined) {
        delete process.env.VENICE_SESSION_FILES;
      } else {
        process.env.VENICE_SESSION_FILES = previousSessionFiles;
      }
      fs.rmSync(watchDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testSessionDiscovery() {
  section("Session file discovery");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-discovery-"));
  const primary = path.join(dir, ".venice-web-session.json");
  const second = path.join(dir, ".venice-web-session-2.json");
  const ignored = path.join(dir, "notes.json");
  const listed = path.join(dir, "listed-account.json");

  const previousSessionFile = process.env.VENICE_SESSION_FILE;
  const previousSessionFiles = process.env.VENICE_SESSION_FILES;

  try {
    for (const file of [primary, second, ignored, listed]) {
      fs.writeFileSync(file, "{}");
    }

    process.env.VENICE_SESSION_FILE = primary;
    delete process.env.VENICE_SESSION_FILES;

    const discovered = discoverSessionFiles();
    ok("includes the configured session file", discovered.includes(primary));
    ok("includes a sibling account file on the same volume", discovered.includes(second));
    ok("ignores unrelated json next to it", !discovered.includes(ignored));

    process.env.VENICE_SESSION_FILES = listed;
    const withList = discoverSessionFiles();
    ok("honours VENICE_SESSION_FILES", withList.includes(listed));
    ok("keeps the configured file too", withList.includes(primary));

    process.env.VENICE_SESSION_FILES = `${listed},${path.join(dir, "missing.json")}`;
    const withMissing = discoverSessionFiles();
    ok("skips a listed file that does not exist", !withMissing.some((f) => f.endsWith("missing.json")));

    const proxy = createVeniceOpenAiProxy([primary, second]);
    ok("a two-account pool loads both", proxy.accounts.length === 2);
  } finally {
    if (previousSessionFile === undefined) {
      delete process.env.VENICE_SESSION_FILE;
    } else {
      process.env.VENICE_SESSION_FILE = previousSessionFile;
    }
    if (previousSessionFiles === undefined) {
      delete process.env.VENICE_SESSION_FILES;
    } else {
      process.env.VENICE_SESSION_FILES = previousSessionFiles;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testRateLimitHelper();
  await testPoolRotationAndFailover();
  await testAccountHotReload();
  testSessionDiscovery();

  console.log(`\n────────────────────────────────────────\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exitCode = 1;
});
