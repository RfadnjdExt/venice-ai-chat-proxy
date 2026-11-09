import { createVeniceOpenAiProxy, discoverSessionFiles, isRateLimitError, parseRateLimitCooldown, VeniceAccount } from "../src/proxy.mjs";

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

async function main() {
  testRateLimitHelper();
  await testPoolRotationAndFailover();

  console.log(`\n────────────────────────────────────────\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Test error:", err);
  process.exitCode = 1;
});
