import fs from "node:fs";
import path from "node:path";
import { discoverSessionFiles } from "../src/proxy.mjs";

// Picks the session file a login should write to.
//
// With no explicit --session-file / VENICE_SESSION_FILE, the account decides:
// an account that already has a session file is refreshed in place, and a new
// account gets the next free `.venice-web-session[-N].json` next to the
// configured file (or in the working directory). That is what makes
// `npm run login` safe to run for a second account without `--session-file`.

export const DEFAULT_SESSION_BASENAME = ".venice-web-session.json";

function readSnapshot(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// A non-empty file with no session id or email (truncated write, empty JSON) is
// treated as free, so the next login overwrites it instead of piling up files.
function isPopulated(file) {
  const snapshot = readSnapshot(file);
  return Boolean(snapshot && (snapshot.sessionId || snapshot.email));
}

export function sessionFileBaseDir() {
  const configured = process.env.VENICE_SESSION_FILE?.trim();
  if (configured) {
    return path.dirname(path.resolve(process.cwd(), configured));
  }
  return process.cwd();
}

function nextFreeSessionFile(dir) {
  const first = path.join(dir, DEFAULT_SESSION_BASENAME);
  if (!isPopulated(first)) {
    return first;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const file = path.join(dir, `.venice-web-session-${index}.json`);
    if (!isPopulated(file)) {
      return file;
    }
  }
  throw new Error(`Could not find a free session file name in ${dir}.`);
}

export function findSessionFileFor({ email, sessionId, userId } = {}) {
  const wantedEmail = String(email ?? "").trim().toLowerCase();
  const wantedSession = String(sessionId ?? "").trim();
  const wantedUser = String(userId ?? "").trim();
  if (!wantedEmail && !wantedSession && !wantedUser) {
    return null;
  }

  // Check the default file first: discovery sorts lexicographically, which puts
  // `.venice-web-session-2.json` before `.venice-web-session.json`.
  const preferred = path.resolve(sessionFileBaseDir(), DEFAULT_SESSION_BASENAME);
  const files = [
    preferred,
    ...discoverSessionFiles().filter((file) => path.resolve(file) !== preferred),
  ];

  for (const file of files) {
    const snapshot = readSnapshot(file);
    if (!snapshot) {
      continue;
    }
    if (wantedSession && snapshot.sessionId === wantedSession) {
      return file;
    }
    if (wantedUser && snapshot.userId && snapshot.userId === wantedUser) {
      return file;
    }
    if (wantedEmail && String(snapshot.email ?? "").trim().toLowerCase() === wantedEmail) {
      return file;
    }
  }
  return null;
}

export function chooseSessionFile({ explicit, email, sessionId, userId } = {}) {
  if (explicit) {
    return path.resolve(process.cwd(), explicit);
  }
  const match = findSessionFileFor({ email, sessionId, userId });
  if (match) {
    return match;
  }
  return nextFreeSessionFile(sessionFileBaseDir());
}