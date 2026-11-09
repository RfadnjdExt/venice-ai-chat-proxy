import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SESSION_BASENAME,
  chooseSessionFile,
  findSessionFileFor,
  sessionFileBaseDir,
} from "../scripts/session-files.mjs";

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

function writeSession(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
}

function readEmail(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).email;
}

async function withTempRepo(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venice-session-files-"));
  const previousCwd = process.cwd();
  const previousSingle = process.env.VENICE_SESSION_FILE;
  const previousList = process.env.VENICE_SESSION_FILES;
  try {
    delete process.env.VENICE_SESSION_FILE;
    delete process.env.VENICE_SESSION_FILES;
    process.chdir(dir);
    await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousSingle === undefined) {
      delete process.env.VENICE_SESSION_FILE;
    } else {
      process.env.VENICE_SESSION_FILE = previousSingle;
    }
    if (previousList === undefined) {
      delete process.env.VENICE_SESSION_FILES;
    } else {
      process.env.VENICE_SESSION_FILES = previousList;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testFreshAccount() {
  section("fresh account");
  await withTempRepo(async (dir) => {
    const chosen = chooseSessionFile({ email: "first@example.com" });
    ok("uses the default file when nothing exists", chosen === path.join(dir, DEFAULT_SESSION_BASENAME));
    ok("the chosen file does not exist yet", !fs.existsSync(chosen));
    ok("base dir is the working directory", sessionFileBaseDir() === dir);
  });
}

async function testExistingAccount() {
  section("existing account");
  await withTempRepo(async (dir) => {
    const primary = path.join(dir, DEFAULT_SESSION_BASENAME);
    writeSession(primary, { email: "first@example.com", sessionId: "sess_1", userId: "user_1" });

    ok(
      "refreshes the file that already holds the account",
      chooseSessionFile({ email: "first@example.com" }) === primary,
    );
    ok(
      "email matching ignores case and spaces",
      chooseSessionFile({ email: "  FIRST@example.com " }) === primary,
    );
    ok(
      "matches by session id when the email is missing",
      chooseSessionFile({ sessionId: "sess_1" }) === primary,
    );
    ok(
      "matches by user id",
      chooseSessionFile({ userId: "user_1" }) === primary,
    );
    ok(
      "a different account gets -2",
      chooseSessionFile({ email: "second@example.com" }) === path.join(dir, ".venice-web-session-2.json"),
    );
  });
}

async function testSecondAccount() {
  section("second account");
  await withTempRepo(async (dir) => {
    writeSession(path.join(dir, DEFAULT_SESSION_BASENAME), { email: "first@example.com", sessionId: "sess_1" });
    const second = path.join(dir, ".venice-web-session-2.json");
    writeSession(second, { email: "second@example.com", sessionId: "sess_2" });

    ok("refreshes the second account in its own file", chooseSessionFile({ email: "second@example.com" }) === second);
    ok(
      "the default file still belongs to the first account",
      chooseSessionFile({ email: "first@example.com" }) === path.join(dir, DEFAULT_SESSION_BASENAME),
    );
    ok(
      "a third account gets -3",
      chooseSessionFile({ email: "third@example.com" }) === path.join(dir, ".venice-web-session-3.json"),
    );
  });
}

async function testBrokenFile() {
  section("broken/empty files");
  await withTempRepo(async (dir) => {
    const primary = path.join(dir, DEFAULT_SESSION_BASENAME);
    fs.writeFileSync(primary, "{not json");
    ok("a corrupt default file is reused", chooseSessionFile({ email: "new@example.com" }) === primary);

    fs.writeFileSync(primary, "{}");
    ok("an empty snapshot is reused", chooseSessionFile({ email: "new@example.com" }) === primary);

    fs.writeFileSync(primary, "");
    ok("a zero-length file is reused", chooseSessionFile({ email: "new@example.com" }) === primary);
  });
}

async function testExplicitAndBaseDir() {
  section("explicit path and configured directory");
  await withTempRepo(async (dir) => {
    const explicit = path.join(dir, "custom-session.json");
    ok("--session-file wins over detection", chooseSessionFile({ explicit, email: "x@example.com" }) === explicit);

    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const configured = path.join(dataDir, DEFAULT_SESSION_BASENAME);
    writeSession(configured, { email: "first@example.com", sessionId: "sess_9" });

    process.env.VENICE_SESSION_FILE = configured;
    ok("base dir follows VENICE_SESSION_FILE", sessionFileBaseDir() === dataDir);
    ok(
      "an existing account in the configured dir is refreshed there",
      chooseSessionFile({ email: "first@example.com" }) === configured,
    );
    ok(
      "a new account lands next to the configured file",
      chooseSessionFile({ email: "second@example.com" }) === path.join(dataDir, ".venice-web-session-2.json"),
    );
  });
}

async function testDiscoveryHelpers() {
  section("findSessionFileFor");
  await withTempRepo(async (dir) => {
    const primary = path.join(dir, DEFAULT_SESSION_BASENAME);
    writeSession(primary, { email: "first@example.com", sessionId: "sess_1" });
    ok("returns null without any identity", findSessionFileFor({}) === null);
    ok("returns null for an unknown account", findSessionFileFor({ email: "nope@example.com" }) === null);
    ok("finds a known account", findSessionFileFor({ email: "first@example.com" }) === primary);
  });
}

async function main() {
  await testFreshAccount();
  await testExistingAccount();
  await testSecondAccount();
  await testBrokenFile();
  await testExplicitAndBaseDir();
  await testDiscoveryHelpers();

  console.log(`\n────────────────────────────────────────\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});