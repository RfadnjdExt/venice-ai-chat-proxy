import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { VeniceWebClient, decodeJwtPayload } from "./client.mjs";
import { AgenticProxy } from "./agentic.mjs";
import { normalizeOpenAiContent } from "./openai-content.mjs";
import {
  buildToolCallDeltas,
  parseToolEmulationSetting,
  parseReasoningBudget,
  parseToolFormatRules,
  resolveToolEmulation,
  runToolEmulation,
  TOOL_FORMAT_NAMES,
  truncateSnippet,
} from "./tool-emulation.mjs";
import { replaceNullBytes } from "./venice-text.mjs";
import { buildUsage, contextOverflowError, createTokenCounter, estimatePromptTokens } from "./context.mjs";

const PORT = Number(process.env.PORT || process.env.VENICE_PROXY_PORT || 3456);
const HOST = process.env.HOST || "0.0.0.0";
const CORS_ALLOW_METHODS = "GET,POST,OPTIONS";
const CORS_DEFAULT_ALLOW_HEADERS =
  "authorization,content-type,accept,origin,user-agent,x-requested-with";
const MODEL_OVERLOADED_MAX_RETRIES = Number(
  process.env.VENICE_MODEL_OVERLOADED_MAX_RETRIES || 2,
);
const MODEL_OVERLOADED_RETRY_DELAY_MS = Number(
  process.env.VENICE_MODEL_OVERLOADED_RETRY_DELAY_MS || 750,
);
const DEBUG = Boolean(process.env.VENICE_DEBUG?.trim());
// Clerk JWTs live about a minute; refresh a little before they lapse.
const AUTH_REFRESH_SKEW_MS = Number(process.env.VENICE_AUTH_REFRESH_SKEW_MS || 10_000);
// Default poll interval for picking up added or removed session files.
const DEFAULT_ACCOUNT_REFRESH_MS = 3000;
// How often a running proxy rescans for added/removed session files. A new
// account therefore joins the pool without a restart; 0 disables the scan.
const ACCOUNT_REFRESH_MS = parseAccountRefreshInterval(process.env.VENICE_ACCOUNT_REFRESH_MS);
const AGENTIC_MODEL_NAME = process.env.VENICE_AGENTIC_MODEL_NAME?.trim() || "agentic";
// Prompt-based tool calling for requests that send `tools`; "off" restores the
// old behavior of ignoring them.
const TOOL_EMULATION_ENABLED = parseToolEmulationSetting(process.env.VENICE_TOOL_EMULATION);
// Per-model tool-call format overrides, e.g. "glm=json,kimi=qwen-xml,*=json".
const TOOL_FORMAT_RULES = parseToolFormatRules(process.env.VENICE_TOOL_FORMATS);
// Characters of reasoning a tool request may produce before an answer or call
// starts (0 = no limit). The longest successful run seen live reasoned for
// 16.5K characters; a runaway one hit 161K and the 5-minute upstream timeout.
const TOOL_REASONING_BUDGET = parseReasoningBudget(process.env.VENICE_TOOL_REASONING_BUDGET);
// Venice's web app sends enableLargeContextChat ("Large Context Chat") to get a
// model's full context; without it the web client's own prompt limit is 50K or
// 25K tokens (from its JS bundle). Only models with largeContextChatEligible in
// the catalog take it. Live, the chat endpoint took a ~200K-token prompt on
// GLM 5.2 with and without the flag (2026-11-05), so it mirrors the web app
// rather than fixing a known limit. "off" never sends it; models that bill
// credits never get it.
const LARGE_CONTEXT_ENABLED = !["off", "0", "false", "no"].includes(
  process.env.VENICE_LARGE_CONTEXT?.trim().toLowerCase() ?? "",
);
// Forced off (with includeVeniceSystemPrompt) whenever tools are emulated.
const TOOL_EMULATION_DISABLED_FEATURES = ["webEnabled", "webScrapeEnabled", "xSearchEnabled"];
if (TOOL_FORMAT_RULES.invalid.length > 0) {
  console.warn(
    `VENICE_TOOL_FORMATS: ignoring ${TOOL_FORMAT_RULES.invalid.join(", ")} (expected pattern=format, format one of ${TOOL_FORMAT_NAMES.join("|")})`,
  );
}
// Venice's own system prompt is off unless a caller asks for it via the model
// suffix; set explicitly so streaming and non-streaming paths never disagree.
const DEFAULT_INCLUDE_VENICE_SYSTEM_PROMPT = false;
const MODEL_SUFFIX_BOOLEAN_FIELDS = new Set([
  "includeVeniceSystemPrompt",
  "webEnabled",
  "webScrapeEnabled",
  "xSearchEnabled",
]);

const STARTED_AT = Date.now();
const REPO_ROOT = new URL("../", import.meta.url);

// Resolves the deployed commit without shelling out to git: reads the checkout
// directly, and falls back to VENICE_BUILD_COMMIT for images built without .git.
function readDeployedCommit() {
  const envCommit = process.env.VENICE_BUILD_COMMIT?.trim();
  if (envCommit) {
    return {
      commit: envCommit,
      branch: process.env.VENICE_BUILD_BRANCH?.trim() || null,
      source: "env",
    };
  }

  try {
    const head = fs.readFileSync(new URL(".git/HEAD", REPO_ROOT), "utf8").trim();

    // Detached HEAD stores the sha itself instead of a ref.
    if (/^[0-9a-f]{40}$/i.test(head)) {
      return { commit: head, branch: null, source: "git" };
    }

    const ref = head.startsWith("ref: ") ? head.slice(5).trim() : null;
    if (!ref) {
      return { commit: null, branch: null, source: "unknown" };
    }
    const branch = ref.replace(/^refs\/heads\//, "");

    try {
      const commit = fs.readFileSync(new URL(`.git/${ref}`, REPO_ROOT), "utf8").trim();
      return { commit, branch, source: "git" };
    } catch {
      // A packed checkout keeps refs in packed-refs rather than loose files.
      const packed = fs.readFileSync(new URL(".git/packed-refs", REPO_ROOT), "utf8");
      for (const line of packed.split("\n")) {
        const [commit, name] = line.trim().split(/\s+/);
        if (name === ref && /^[0-9a-f]{40}$/i.test(commit || "")) {
          return { commit, branch, source: "git-packed" };
        }
      }
      return { commit: null, branch, source: "unknown" };
    }
  } catch {
    return { commit: null, branch: null, source: "unknown" };
  }
}

function buildSupportInfo(proxy) {
  const { commit, branch, source } = readDeployedCommit();
  return {
    ok: true,
    service: "venice-openai-proxy",
    build: {
      commit,
      commit_short: commit ? commit.slice(0, 7) : null,
      branch,
      source,
    },
    runtime: {
      node: process.version,
      pid: process.pid,
      started_at: new Date(STARTED_AT).toISOString(),
      uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    },
    session: {
      session_file: proxy.client.sessionFile,
      email: proxy.auth?.userSession?.email ?? proxy.client.email ?? null,
      has_cached_auth: proxy.hasFreshAuth(),
      auth_expires_at: proxy.authExpiresAt
        ? new Date(proxy.authExpiresAt).toISOString()
        : null,
    },
    accounts: typeof proxy.getAccountsInfo === "function" ? proxy.getAccountsInfo() : undefined,
    models: {
      sampling_defaults_cached: proxy.modelSettings.size,
      loaded_at: proxy.modelSettingsLoadedAt
        ? new Date(proxy.modelSettingsLoadedAt).toISOString()
        : null,
    },
  };
}

function debugLog(label, data) {
  if (!DEBUG) return;
  const prefix = `[debug:${label}]`;
  if (data === undefined) {
    process.stderr.write(`${prefix}\n`);
  } else if (typeof data === "string") {
    process.stderr.write(`${prefix} ${data}\n`);
  } else {
    process.stderr.write(`${prefix} ${JSON.stringify(data)}\n`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getTextLength(value) {
  return typeof value === "string" ? value.length : 0;
}

function collectStreamLengths(events) {
  let contentLength = 0;
  let reasoningLength = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") {
      continue;
    }

    if (event.kind === "content") {
      contentLength += getTextLength(event.content);
      reasoningLength += getTextLength(event.reasoning_content);
      continue;
    }

    if (
      event.kind === "reasoning" ||
      event.kind === "thinking" ||
      typeof event.reasoning === "string" ||
      typeof event.thinking === "string"
    ) {
      reasoningLength +=
        getTextLength(event.content) +
        getTextLength(event.reasoning) +
        getTextLength(event.thinking);
    }
  }

  return { contentLength, reasoningLength };
}

// Estimated completion size of a collected Venice reply: answer text plus
// reasoning, which also takes up the model's output budget.
function estimateCompletionTokens(events) {
  const counter = createTokenCounter();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind === "content") {
      counter.add(event.content);
      counter.add(event.reasoning_content);
    }
  }
  return counter.tokens;
}

function getRequestOrigin(req) {
  return (
    req.headers.origin ||
    req.headers.referer ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function getRequestLength(req, bodyText = "") {
  const headerLength = Number(req.headers["content-length"]);
  if (Number.isFinite(headerLength) && headerLength >= 0) {
    return headerLength;
  }
  return Buffer.byteLength(bodyText || "", "utf8");
}

function logIncomingRequest(req, url, bodyLength = 0) {
  console.log(
    `[${nowIso()}] incoming ${req.method} ${url.pathname} origin=${getRequestOrigin(req)} length=${bodyLength}`,
  );
}

function logOutgoingResponse({
  req,
  url,
  status,
  model = null,
  contentLength = 0,
  reasoningLength = 0,
  durationMs,
  streamDurationMs = null,
  toolCount = null,
  toolCallCount = 0,
  toolAttempts = 1,
}) {
  const streamPart =
    typeof streamDurationMs === "number"
      ? ` stream_ms=${streamDurationMs}`
      : "";
  const modelPart = model ? ` model=${model}` : "";
  // Only requests that went through tool emulation report tool counts.
  const toolsPart =
    typeof toolCount === "number"
      ? ` tools=${toolCount} tool_calls=${toolCallCount}${toolAttempts > 1 ? ` tool_attempts=${toolAttempts}` : ""}`
      : "";
  console.log(
    `[${nowIso()}] outgoing ${req.method} ${url.pathname} status=${status}${modelPart} content_chars=${contentLength} reasoning_chars=${reasoningLength}${toolsPart} duration_ms=${durationMs}${streamPart}`,
  );
}

const TOOL_LOG_OUTPUT_MAX_CHARS = 4000;

// Logs what runToolEmulation reports, raw model outputs included (truncated).
function logToolEmulationEvent({ type, reason, outputs }, model) {
  const message =
    type === "retry"
      ? "unparsed tool call; retrying once"
      : type === "overrun"
        ? "reasoning overran the budget; cancelled and retrying once"
        : type === "empty"
          ? "empty reply; retrying once with the format repeated"
          : type === "failed"
            ? "retry failed too"
            : "ignoring an unparsed call after a valid one";
  const outputPart = outputs
    .map((output, index) => ` output${index + 1}=${JSON.stringify(truncateSnippet(output, TOOL_LOG_OUTPUT_MAX_CHARS))}`)
    .join("");
  console.warn(`[${nowIso()}] tool emulation: ${message} (${reason}) model=${model}${outputPart}`);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function corsHeaders(req) {
  const requestedHeaders = req?.headers["access-control-request-headers"];
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS,
    "access-control-allow-headers":
      typeof requestedHeaders === "string" && requestedHeaders.trim()
        ? requestedHeaders
        : CORS_DEFAULT_ALLOW_HEADERS,
    "access-control-max-age": "86400",
    "access-control-expose-headers": "content-type",
    vary: "access-control-request-headers",
  };
}

function applyCorsHeaders(req, res) {
  for (const [name, value] of Object.entries(corsHeaders(req))) {
    res.setHeader(name, value);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isModelOverloadedError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.startsWith("HTTP 429:") &&
    error.message.includes('"error":"modelOverloaded"')
  );
}

function isUnauthorizedError(error) {
  return error instanceof Error && error.message.startsWith("HTTP 401:");
}

export function isRateLimitError(error) {
  if (!error) {
    return false;
  }
  if (isModelOverloadedError(error)) {
    return false;
  }
  if (error.status === 429) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith("HTTP 429:") ||
    message.includes("Rate limit exceeded") ||
    message.includes("rate_limit_exceeded")
  );
}

export function parseRateLimitCooldown(error) {
  const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
  if (!error) {
    return Date.now() + DEFAULT_COOLDOWN_MS;
  }

  if (error.rateLimitReset) {
    const val = Number(error.rateLimitReset);
    if (Number.isFinite(val)) {
      if (val > 1e11) {
        return Math.max(Date.now() + 5000, val);
      }
      if (val > 1e9) {
        return Math.max(Date.now() + 5000, val * 1000);
      }
      return Date.now() + Math.max(5, val) * 1000;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/reset[:\s]+(\d+)/i);
  if (match) {
    const val = Number(match[1]);
    if (val > 1e11) return val;
    if (val > 1e9) return val * 1000;
  }

  return Date.now() + DEFAULT_COOLDOWN_MS;
}

// Thrown when every account is rate limited. The proxy answers HTTP 400 (not
// 429) so OpenAI-compatible clients stop retrying: most retry 429/408/409/5xx
// automatically, but not 400. The body keeps a machine-readable code and the
// earliest reset time.
export class AllAccountsRateLimitedError extends Error {
  constructor(message, resetAt = null) {
    super(message);
    this.name = "AllAccountsRateLimitedError";
    this.status = 400;
    this.code = "all_accounts_rate_limited";
    this.rateLimitedUntil = Number.isFinite(resetAt) ? resetAt : null;
  }

  get retryable() {
    return false;
  }

  get retryAfterSeconds() {
    if (!this.rateLimitedUntil) {
      return null;
    }
    return Math.max(1, Math.ceil((this.rateLimitedUntil - Date.now()) / 1000));
  }
}

// `VENICE_ACCOUNT_REFRESH_MS` is the poll interval for picking up added or
// removed session files. Empty/unset uses the default; "off"/"0"/"false"/"no"
// disables the scan; anything else non-numeric falls back to the default.
export function parseAccountRefreshInterval(value) {
  if (value === undefined || value === null) {
    return DEFAULT_ACCOUNT_REFRESH_MS;
  }
  const text = String(value).trim().toLowerCase();
  if (text === "") {
    return DEFAULT_ACCOUNT_REFRESH_MS;
  }
  if (["off", "false", "no"].includes(text)) {
    return 0;
  }
  const ms = Number(text);
  if (Number.isFinite(ms) && ms >= 0) {
    return ms;
  }
  return DEFAULT_ACCOUNT_REFRESH_MS;
}

// A login utility may still be writing the file when the scan runs, so only a
// complete snapshot counts as a usable account.
function readSessionSnapshot(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.sessionId || parsed.clerkJwt) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function discoverSessionFiles() {
  const files = new Set();

  const envList = process.env.VENICE_SESSION_FILES?.trim();
  if (envList) {
    for (const item of envList.split(/[,;]/)) {
      const trimmed = item.trim();
      if (trimmed) {
        files.add(path.resolve(process.cwd(), trimmed));
      }
    }
  }

  const singleFile = process.env.VENICE_SESSION_FILE?.trim();
  if (singleFile) {
    const resolvedSingle = path.resolve(process.cwd(), singleFile);
    files.add(resolvedSingle);

    // Session files often live on a mounted volume (Docker: /data), where the
    // cwd scan below cannot see them. Pick up sibling account files next to the
    // configured one so adding an account only means adding a file.
    try {
      const dir = path.dirname(resolvedSingle);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && /^\.venice-web-session.*\.json$/i.test(entry.name)) {
          files.add(path.resolve(dir, entry.name));
        }
      }
    } catch {
      // ignore an unreadable or missing directory
    }
  }

  try {
    const cwdEntries = fs.readdirSync(process.cwd(), { withFileTypes: true });
    for (const entry of cwdEntries) {
      if (entry.isFile() && /^\.venice-web-session.*\.json$/i.test(entry.name)) {
        files.add(path.resolve(process.cwd(), entry.name));
      }
    }
  } catch {
    // ignore
  }

  const sessionsDir = path.resolve(process.cwd(), "sessions");
  try {
    if (fs.existsSync(sessionsDir) && fs.statSync(sessionsDir).isDirectory()) {
      const sessionEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      for (const entry of sessionEntries) {
        if (entry.isFile() && /\.json$/i.test(entry.name)) {
          files.add(path.resolve(sessionsDir, entry.name));
        }
      }
    }
  } catch {
    // ignore
  }

  const existing = Array.from(files).filter((file) => {
    try {
      return fs.existsSync(file) && fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });

  if (existing.length > 0) {
    return existing.sort();
  }

  return [path.resolve(process.cwd(), ".venice-web-session.json")];
}

async function retryModelOverloaded(operation, { label, model }) {
  const maxRetries = Number.isFinite(MODEL_OVERLOADED_MAX_RETRIES)
    ? Math.max(0, MODEL_OVERLOADED_MAX_RETRIES)
    : 0;
  const baseDelayMs = Number.isFinite(MODEL_OVERLOADED_RETRY_DELAY_MS)
    ? Math.max(0, MODEL_OVERLOADED_RETRY_DELAY_MS)
    : 0;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isModelOverloadedError(error) || attempt >= maxRetries) {
        throw error;
      }

      const delayMs = baseDelayMs * (attempt + 1);
      console.warn(
        `[${nowIso()}] upstream model overloaded; retrying ${label} model=${model} attempt=${attempt + 1}/${maxRetries} delay_ms=${delayMs}`,
      );
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

function splitMessages(messages) {
  const prompt = [];
  const systemParts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const content = normalizeOpenAiContent(message?.content);
    if (!content) {
      continue;
    }
    if (role === "system") {
      systemParts.push(content);
      continue;
    }
    const next =
      role === "tool"
        ? { role: "assistant", content: `Tool result:\n${content}` }
        : { role: role === "assistant" ? "assistant" : "user", content };
    // Venice's chat endpoint keeps only the last of several same-role messages
    // in a row, so neighbours are merged into one turn instead of being lost.
    const previous = prompt.at(-1);
    if (previous?.role === next.role) {
      previous.content = `${previous.content}\n\n${next.content}`;
      continue;
    }
    prompt.push(next);
  }
  return {
    prompt,
    systemPrompt: systemParts.join("\n\n"),
  };
}

function appendNoThinkToLatestUserMessage(prompt) {
  if (!Array.isArray(prompt)) {
    return prompt;
  }

  const latestUserIndex = prompt.findLastIndex((message) => message?.role === "user");
  if (latestUserIndex === -1) {
    return prompt;
  }

  return prompt.map((message, index) => {
    if (index !== latestUserIndex || typeof message?.content !== "string") {
      return message;
    }
    if (message.content.startsWith("/no_think ")) {
      return message;
    }
    return {
      ...message,
      content: `/no_think ${message.content}`,
    };
  });
}

function toChatCompletionId(id, created) {
  if (typeof id !== "string" || !id) {
    return `chatcmpl_${created}`;
  }
  return id.startsWith("chatcmpl") ? id : `chatcmpl_${id}`;
}

function buildChatCompletionResponse({
  requestModel,
  completionId,
  text,
  created,
  toolCalls = [],
  usage = null,
}) {
  const message = {
    role: "assistant",
    content: text,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  const response = {
    id: completionId || `chatcmpl_${created}`,
    object: "chat.completion",
    created,
    model: requestModel,
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        message,
      },
    ],
  };
  if (usage) {
    response.usage = usage;
  }
  return response;
}

function writeSseChunk(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// Rewrites outerface agent events into OpenAI Responses events. Outerface
// streams reasoning as output_text on a reasoning item; Responses clients expect
// a reasoning summary, kept apart from the answer text.
function createResponsesTranslator({ model, created }) {
  const items = new Map(); // output_index -> { type, text }
  const output = [];
  let response = {
    id: `resp_${created}`,
    object: "response",
    created_at: created,
    status: "in_progress",
    model,
  };

  return {
    snapshot() {
      return { ...response, output };
    },

    translate({ event, data }) {
      if (
        event === "response.created" ||
        event === "response.in_progress" ||
        event === "response.completed"
      ) {
        response = { ...response, ...data?.response, model };
        const completed = event === "response.completed";
        return [{ event, data: { ...data, response: { ...response, output: completed ? output : [] } } }];
      }

      if (event === "response.output_item.added") {
        const item = data?.item ?? {};
        items.set(data?.output_index, { type: item.type, text: "" });
        return [
          {
            event,
            data: item.type === "reasoning" ? { ...data, item: { ...item, summary: [] } } : data,
          },
        ];
      }

      const tracked = items.get(data?.output_index);
      const isReasoning = tracked?.type === "reasoning";

      if (event === "response.output_text.delta" || event === "response.output_text.done") {
        const done = event === "response.output_text.done";
        if (tracked && done && typeof data?.text === "string") {
          tracked.text = data.text;
        } else if (tracked && !done && typeof data?.delta === "string") {
          tracked.text += data.delta;
        }
        if (!isReasoning) {
          return [{ event, data }];
        }
        const { content_index: _contentIndex, ...rest } = data;
        return [
          {
            event: `response.reasoning_summary_text.${done ? "done" : "delta"}`,
            data: { ...rest, summary_index: 0 },
          },
        ];
      }

      if (event === "response.content_part.added" || event === "response.content_part.done") {
        if (!isReasoning) {
          return [{ event, data }];
        }
        const done = event === "response.content_part.done";
        const { content_index: _contentIndex, part: _part, ...rest } = data;
        return [
          {
            event: `response.reasoning_summary_part.${done ? "done" : "added"}`,
            data: {
              ...rest,
              summary_index: 0,
              part: { type: "summary_text", text: done ? tracked.text : "" },
            },
          },
        ];
      }

      if (event === "response.output_item.done") {
        let item = data?.item ?? {};
        if (item.type === "reasoning") {
          item = { ...item, summary: [{ type: "summary_text", text: tracked?.text ?? "" }] };
          output.push(item);
        } else if (item.type === "message") {
          // workflow/chat leaves the finished item's content empty; the text
          // only arrives through the output_text events.
          const content =
            Array.isArray(item.content) && item.content.length > 0
              ? item.content
              : [{ type: "output_text", text: tracked?.text ?? "" }];
          item = { ...item, content: content.map((part) => ({ annotations: [], ...part })) };
          output.push(item);
        }
        return [{ event, data: { ...data, item } }];
      }

      return [];
    },
  };
}

function createStreamStats() {
  return {
    contentLength: 0,
    reasoningLength: 0,
  };
}

function updateStreamStats(stats, event) {
  if (!event || typeof event !== "object") {
    return;
  }

  if (event.kind === "content") {
    stats.contentLength += getTextLength(event.content);
    stats.reasoningLength += getTextLength(event.reasoning_content);
    return;
  }

  if (
    event.kind === "reasoning" ||
    event.kind === "thinking" ||
    typeof event.reasoning === "string" ||
    typeof event.thinking === "string"
  ) {
    stats.reasoningLength +=
      getTextLength(event.content) +
      getTextLength(event.reasoning) +
      getTextLength(event.thinking);
  }
}

function isTeeModel(model) {
  return typeof model === "string" && model.startsWith("e2ee-");
}

function parseBooleanSuffixValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "true":
    case "1":
    case "on":
    case "yes":
      return true;
    case "false":
    case "0":
    case "off":
    case "no":
      return false;
    default:
      return null;
  }
}

function parseModelFeatureSuffix(model) {
  if (typeof model !== "string") {
    return { model, features: {} };
  }

  const separatorIndex = model.indexOf(":");
  if (separatorIndex === -1) {
    return { model, features: {} };
  }

  const baseModel = model.slice(0, separatorIndex);
  const suffix = model.slice(separatorIndex + 1);
  if (!baseModel || !suffix.includes("=")) {
    return { model, features: {} };
  }

  const features = {};
  for (const part of suffix.split("&")) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const rawName = part.slice(0, equalsIndex);
    const rawValue = part.slice(equalsIndex + 1);
    let name;
    let value;
    try {
      name = decodeURIComponent(rawName);
      value = decodeURIComponent(rawValue);
    } catch {
      name = rawName;
      value = rawValue;
    }

    if (!MODEL_SUFFIX_BOOLEAN_FIELDS.has(name)) {
      continue;
    }

    const parsedValue = parseBooleanSuffixValue(value);
    if (parsedValue !== null) {
      features[name] = parsedValue;
    }
  }

  return Object.keys(features).length > 0
    ? { model: baseModel, features }
    : { model, features: {} };
}

// Reports where the reasoning flag came from so the translation log can explain itself.
function resolveReasoning(payload, model) {
  if (typeof payload.reasoning === "boolean") {
    return { reasoning: payload.reasoning, source: "reasoning" };
  }

  if (typeof payload.reasoning_effort === "string") {
    const effort = payload.reasoning_effort.trim().toLowerCase();
    return { reasoning: effort !== "none", source: `reasoning_effort=${effort}` };
  }

  return {
    reasoning: !isTeeModel(model),
    source: isTeeModel(model) ? "tee-model-default" : "model-default",
  };
}

// Picks the sampling values Venice's own web client would send: an explicit
// request value wins, otherwise the model catalog default keeps proxy output
// reproducible against the web UI.
function resolveSampling(payload, catalogSettings) {
  const sampling = {};

  if (typeof payload.temperature === "number") {
    sampling.temperature = { value: payload.temperature, source: "request" };
  } else if (typeof catalogSettings?.temperature === "number") {
    sampling.temperature = { value: catalogSettings.temperature, source: "catalog" };
  }

  if (typeof payload.top_p === "number") {
    sampling.topP = { value: payload.top_p, source: "request" };
  } else if (typeof catalogSettings?.topP === "number") {
    sampling.topP = { value: catalogSettings.topP, source: "catalog" };
  }

  return sampling;
}

function logRequestTranslation({
  requestedModel,
  options,
  features,
  reasoningSource,
  noThinkApplied,
  sampling,
  veniceSystemPromptSource,
  toolEmulation = null,
  toolOverrides = [],
  nullBytesReplaced = 0,
}) {
  const parts = [
    `model=${JSON.stringify(requestedModel ?? "")}`,
    `venice_model=${options.model}`,
    `reasoning=${options.reasoning}(${reasoningSource})`,
    `venice_system_prompt=${options.includeVeniceSystemPrompt}(${veniceSystemPromptSource})`,
    `venice_params=${JSON.stringify(features)}`,
  ];
  if (noThinkApplied) {
    parts.push("no_think=true");
  }
  if (typeof options.temperature === "number") {
    parts.push(`temperature=${options.temperature}(${sampling?.temperature?.source ?? "request"})`);
  }
  if (typeof options.topP === "number") {
    parts.push(`top_p=${options.topP}(${sampling?.topP?.source ?? "request"})`);
  }
  if (toolEmulation) {
    parts.push(`tools=${toolEmulation.tools.length}`);
    parts.push(`tool_choice=${toolEmulation.toolChoiceLabel}`);
    parts.push(`tool_format=${toolEmulation.format}`);
    if (toolOverrides.length > 0) {
      parts.push(`disabled_for_tools=${toolOverrides.join(",")}`);
    }
  }
  if (nullBytesReplaced > 0) {
    parts.push(`null_bytes_replaced=${nullBytesReplaced}`);
  }
  if (options.enableLargeContextChat) {
    parts.push("large_context=on");
  }
  parts.push(`est_prompt_tokens=${estimatePromptTokens(options.promptMessages, options.systemPrompt)}`);
  parts.push(`messages=${Array.isArray(options.promptMessages) ? options.promptMessages.length : 0}`);
  parts.push(`system_chars=${getTextLength(options.systemPrompt)}`);
  if (options.requestId) {
    parts.push(`request_id=${options.requestId}`);
  }

  console.log(`[${nowIso()}] translate ${parts.join(" ")}`);
}

function buildVeniceChatOptions({
  payload,
  model,
  prompt,
  systemPrompt,
  requestId,
  resolveModelSettings,
  toolEmulation = null,
}) {
  const parsedModel = parseModelFeatureSuffix(model);
  const { reasoning, source: reasoningSource } = resolveReasoning(payload, parsedModel.model);
  const promptMessages = reasoning ? prompt : appendNoThinkToLatestUserMessage(prompt);
  // Only report the prefix when it actually reached the outgoing message.
  const noThinkApplied = Array.isArray(promptMessages)
    ? promptMessages.some(
        (message) =>
          message?.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("/no_think "),
      )
    : false;
  // Venice rejects null bytes anywhere in the prompt; see venice-text.mjs.
  const nullBytes = { replaced: 0 };
  const options = {
    model: parsedModel.model,
    promptMessages: replaceNullBytes(promptMessages, nullBytes),
    systemPrompt: replaceNullBytes(systemPrompt, nullBytes),
    requestId,
    reasoning,
    ...parsedModel.features,
  };

  const veniceSystemPromptFromSuffix =
    typeof parsedModel.features.includeVeniceSystemPrompt === "boolean";
  options.includeVeniceSystemPrompt = veniceSystemPromptFromSuffix
    ? parsedModel.features.includeVeniceSystemPrompt
    : DEFAULT_INCLUDE_VENICE_SYSTEM_PROMPT;
  let veniceSystemPromptSource = veniceSystemPromptFromSuffix ? "suffix" : "default";

  // Venice's own system prompt and server-side search compete with the tool
  // instructions, so emulated requests always go without them.
  const toolOverrides = [];
  if (toolEmulation) {
    for (const name of TOOL_EMULATION_DISABLED_FEATURES) {
      if (options[name]) {
        toolOverrides.push(name);
      }
      options[name] = false;
    }
    if (options.includeVeniceSystemPrompt) {
      toolOverrides.push("includeVeniceSystemPrompt");
    }
    options.includeVeniceSystemPrompt = false;
    veniceSystemPromptSource = "tools";
  }

  const catalogEntry = resolveModelSettings?.(parsedModel.model) ?? null;
  const sampling = resolveSampling(payload, catalogEntry);
  if (sampling.temperature) {
    options.temperature = sampling.temperature.value;
  }
  if (sampling.topP) {
    options.topP = sampling.topP.value;
  }
  // Opt in to the model's full context like the web app does, for eligible
  // models that do not bill credits (see LARGE_CONTEXT_ENABLED).
  if (LARGE_CONTEXT_ENABLED && catalogEntry?.largeContextChatEligible === true && catalogEntry.usesCredits !== true) {
    options.enableLargeContextChat = true;
  }

  logRequestTranslation({
    requestedModel: model,
    options,
    features: parsedModel.features,
    reasoningSource,
    noThinkApplied,
    sampling,
    veniceSystemPromptSource,
    toolEmulation,
    toolOverrides,
    nullBytesReplaced: nullBytes.replaced,
  });

  return options;
}

export class VeniceAccount {
  constructor(sessionFile) {
    this.sessionFile = path.resolve(sessionFile);
    this.client = new VeniceWebClient({ sessionFile: this.sessionFile });
    this.agentic = new AgenticProxy(this.client);
    this.authPromise = null;
    this.auth = null;
    this.authExpiresAt = 0;
    this.rateLimitedUntil = 0;
    this.requestCount = 0;
  }

  get identifier() {
    const email = this.auth?.userSession?.email || this.client.email;
    const base = path.basename(this.sessionFile);
    return email ? `${email} (${base})` : base;
  }

  isRateLimited() {
    return Date.now() < this.rateLimitedUntil;
  }

  buildMissingSessionError() {
    return new Error(
      `No valid Venice web session found at ${this.sessionFile}. Run "node .\\scripts\\login.mjs --session-file ${this.sessionFile}" to create it.`,
    );
  }

  cacheAuth(auth) {
    const expiresAt = decodeJwtPayload(auth.login.clerkJwt)?.exp;
    this.auth = auth;
    this.authExpiresAt = typeof expiresAt === "number" ? expiresAt * 1000 : 0;
    return auth;
  }

  invalidateAuth() {
    this.auth = null;
    this.authExpiresAt = 0;
  }

  hasFreshAuth() {
    return Boolean(this.auth) && this.authExpiresAt > Date.now() + AUTH_REFRESH_SKEW_MS;
  }

  async ensureAuth() {
    if (this.hasFreshAuth()) {
      return this.auth;
    }

    if (!this.authPromise) {
      this.authPromise = this.authenticate().finally(() => {
        this.authPromise = null;
      });
    }
    return await this.authPromise;
  }

  async authenticate() {
    if (this.client.sessionId) {
      try {
        const clerkJwt = await this.client.refreshClerkJwt();
        const userSession =
          this.auth?.userSession ?? (await this.client.getUserSession(clerkJwt));
        this.client.writeSavedSession({ lastValidatedAt: Date.now() });
        return this.cacheAuth({
          source: "refresh",
          login: {
            signInAttemptId: null,
            sessionId: this.client.sessionId,
            clerkJwt,
          },
          userSession,
        });
      } catch {
        this.invalidateAuth();
      }
    }

    const saved = this.client.readSavedSession();
    if (!saved) {
      throw this.buildMissingSessionError();
    }

    this.client.restoreSavedSession(saved);
    if (this.client.hasUsableSavedJwt(saved)) {
      try {
        const userSession = await this.client.getUserSession(saved.clerkJwt);
        this.client.writeSavedSession({ lastValidatedAt: Date.now() });
        return this.cacheAuth({
          source: "session",
          login: {
            signInAttemptId: null,
            sessionId: this.client.sessionId,
            clerkJwt: this.client.clerkJwt,
          },
          userSession,
        });
      } catch {
        this.client.restoreSavedSession(saved);
      }
    }

    try {
      const restored = await this.client.restoreSessionFromCookies();
      const userSession = await this.client.getUserSession(restored.clerkJwt);
      this.client.writeSavedSession({
        lastValidatedAt: Date.now(),
        restoredAt: Date.now(),
      });
      return this.cacheAuth({
        source: restored.source,
        login: {
          signInAttemptId: null,
          sessionId: restored.sessionId,
          clerkJwt: restored.clerkJwt,
        },
        userSession,
      });
    } catch {
      throw this.buildMissingSessionError();
    }
  }
}

export class VeniceOpenAiProxy {
  constructor(sessionFiles) {
    this.sessionFiles =
      Array.isArray(sessionFiles) && sessionFiles.length > 0
        ? sessionFiles.map((file) => path.resolve(file))
        : null;
    this.accounts = [];
    this.accountIndex = 0;
    this.currentAccount = null;
    this.accountWatcher = null;
    this.refreshAccounts();

    // Per-model sampling defaults from Venice's encrypted model catalog, keyed
    // by every id a caller might use (canonical, api, aliases).
    this.modelSettings = new Map();
    this.modelSettingsLoadedAt = 0;
  }

  refreshAccounts(files) {
    const discovered =
      Array.isArray(files) && files.length > 0
        ? files.map((file) => path.resolve(file))
        : this.sessionFiles || discoverSessionFiles();
    const existingMap = new Map(this.accounts.map((acc) => [acc.sessionFile, acc]));
    const nextAccounts = [];

    for (const file of discovered) {
      const resolved = path.resolve(file);
      if (existingMap.has(resolved)) {
        nextAccounts.push(existingMap.get(resolved));
      } else {
        nextAccounts.push(new VeniceAccount(resolved));
      }
    }

    if (nextAccounts.length === 0) {
      nextAccounts.push(new VeniceAccount(path.resolve(process.cwd(), ".venice-web-session.json")));
    }

    // Keep the rotation pointer on the same account across a rebuild so adding
    // a file cannot make the next request repeat (or skip) an account.
    const pointerAccount = this.accounts[this.accountIndex] ?? null;
    const currentPath = this.currentAccount?.sessionFile ?? null;

    this.accounts = nextAccounts;

    let pointerIndex = pointerAccount ? nextAccounts.indexOf(pointerAccount) : -1;
    if (pointerIndex < 0 && currentPath) {
      pointerIndex = nextAccounts.findIndex((acc) => acc.sessionFile === currentPath);
    }
    this.accountIndex =
      pointerIndex >= 0 ? pointerIndex : Math.max(0, Math.min(this.accountIndex, nextAccounts.length - 1));
    this.currentAccount =
      (currentPath && nextAccounts.find((acc) => acc.sessionFile === currentPath)) ||
      nextAccounts[this.accountIndex] ||
      nextAccounts[0];
    return this.accounts;
  }

  // Adds/removes accounts for the running pool without touching the cached
  // auth of accounts that stay, and without dropping the pool when every file
  // is momentarily unreadable (a login in progress). Returns what changed.
  syncAccounts(files) {
    const discovered = (
      Array.isArray(files) && files.length > 0
        ? files.map((file) => path.resolve(file))
        : this.sessionFiles || discoverSessionFiles()
    ).filter((file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    });
    const ready = discovered.filter((file) => readSessionSnapshot(file));
    if (ready.length === 0) {
      return { added: [], removed: [] };
    }

    const before = new Map(this.accounts.map((acc) => [acc.sessionFile, acc]));
    const readySet = new Set(ready);
    const discoveredSet = new Set(discovered);
    const added = ready.filter((file) => !before.has(file));
    // Only a file that disappeared removes an account. A file that exists but
    // cannot be read right now (the proxy rewriting it, a login half-done)
    // keeps its place and its cached auth.
    const removed = this.accounts
      .filter((acc) => !discoveredSet.has(acc.sessionFile))
      .map((acc) => acc.sessionFile);
    if (added.length === 0 && removed.length === 0) {
      return { added: [], removed: [] };
    }

    const pointerAccount = this.accounts[this.accountIndex] ?? null;
    const currentPath = this.currentAccount?.sessionFile ?? null;

    // Existing accounts are reused even when their file is momentarily
    // unreadable; a new file is only added once it holds a complete snapshot.
    const nextAccounts = discovered
      .map((file) => before.get(file) ?? (readySet.has(file) ? new VeniceAccount(file) : null))
      .filter(Boolean);
    this.accounts = nextAccounts;

    let pointerIndex = pointerAccount ? nextAccounts.indexOf(pointerAccount) : -1;
    if (pointerIndex < 0 && currentPath) {
      pointerIndex = nextAccounts.findIndex((acc) => acc.sessionFile === currentPath);
    }
    this.accountIndex =
      pointerIndex >= 0 ? pointerIndex : Math.max(0, Math.min(this.accountIndex, nextAccounts.length - 1));
    this.currentAccount =
      (currentPath && nextAccounts.find((acc) => acc.sessionFile === currentPath)) ||
      nextAccounts[this.accountIndex] ||
      nextAccounts[0];

    return { added, removed };
  }

  watchAccounts(intervalMs = ACCOUNT_REFRESH_MS) {
    this.stopAccountWatcher();
    const interval = Number(intervalMs);
    if (!Number.isFinite(interval) || interval <= 0) {
      return null;
    }
    this.accountWatcher = setInterval(() => {
      try {
        const { added, removed } = this.syncAccounts();
        for (const file of added) {
          console.log(`[${nowIso()}] account added to pool: ${path.basename(file)}`);
        }
        for (const file of removed) {
          console.log(`[${nowIso()}] account removed from pool: ${path.basename(file)}`);
        }
      } catch (error) {
        console.warn(
          `[${nowIso()}] account refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, interval);
    if (typeof this.accountWatcher.unref === "function") {
      this.accountWatcher.unref();
    }
    return this.accountWatcher;
  }

  stopAccountWatcher() {
    if (this.accountWatcher) {
      clearInterval(this.accountWatcher);
      this.accountWatcher = null;
    }
  }

  get activeAccount() {
    return this.currentAccount || this.accounts[this.accountIndex % this.accounts.length] || this.accounts[0];
  }

  get client() {
    return this.activeAccount.client;
  }

  get agentic() {
    return this.activeAccount.agentic;
  }

  get auth() {
    return this.activeAccount.auth;
  }

  get authExpiresAt() {
    return this.activeAccount.authExpiresAt;
  }

  buildMissingSessionError() {
    return this.activeAccount.buildMissingSessionError();
  }

  cacheAuth(auth) {
    return this.activeAccount.cacheAuth(auth);
  }

  invalidateAuth() {
    this.activeAccount.invalidateAuth();
  }

  hasFreshAuth() {
    return this.activeAccount.hasFreshAuth();
  }

  async ensureAuth() {
    return await this.activeAccount.ensureAuth();
  }

  getNextAccount() {
    const total = this.accounts.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.accountIndex + i) % total;
      const candidate = this.accounts[idx];
      if (!candidate.isRateLimited()) {
        this.accountIndex = (idx + 1) % total;
        return candidate;
      }
    }
    return null;
  }

  getAccountsInfo() {
    return {
      total: this.accounts.length,
      available: this.accounts.filter((a) => !a.isRateLimited()).length,
      accounts: this.accounts.map((acc, index) => ({
        index,
        session_file: acc.sessionFile,
        email: acc.auth?.userSession?.email ?? acc.client.email ?? null,
        rate_limited: acc.isRateLimited(),
        rate_limited_until: acc.isRateLimited()
          ? new Date(acc.rateLimitedUntil).toISOString()
          : null,
        requests: acc.requestCount,
      })),
    };
  }

  buildAllAccountsRateLimitedError() {
    const total = this.accounts.length;
    const earliestReset = Math.max(
      Date.now(),
      Math.min(...this.accounts.map((acc) => acc.rateLimitedUntil || 0)),
    );
    const waitMinutes = Math.max(1, Math.ceil((earliestReset - Date.now()) / 60000));
    const resetIso = new Date(earliestReset).toISOString();
    return new AllAccountsRateLimitedError(
      `HTTP 429: Rate limit exceeded on all ${total} accounts. Earliest reset at ${resetIso} (~${waitMinutes}m).`,
      earliestReset,
    );
  }

  // Runs an upstream call with a cached JWT, retrying once on 401 and rotating to
  // the next available account on 429 rate limits.
  async callWithAuth(operation, { label, model }) {
    const totalAccounts = this.accounts.length;
    let accountsAttempted = 0;
    let lastError = null;

    while (accountsAttempted < totalAccounts) {
      const account = this.getNextAccount();
      if (!account) {
        throw this.buildAllAccountsRateLimitedError();
      }

      accountsAttempted += 1;
      this.currentAccount = account;
      account.requestCount += 1;

      try {
        let retriedUnauthorized = false;
        return await retryModelOverloaded(
          async (attempt) => {
            const auth = typeof this.ensureAuth === "function" && this.ensureAuth !== VeniceOpenAiProxy.prototype.ensureAuth
              ? await this.ensureAuth()
              : await account.ensureAuth();
            try {
              return await operation(auth, attempt, account);
            } catch (error) {
              if (retriedUnauthorized || !isUnauthorizedError(error)) {
                throw error;
              }
              retriedUnauthorized = true;
              console.warn(
                `[${nowIso()}] upstream rejected cached session for ${account.identifier}; refreshing auth and retrying ${label}`,
              );
              account.invalidateAuth();
              const refreshedAuth = typeof this.ensureAuth === "function" && this.ensureAuth !== VeniceOpenAiProxy.prototype.ensureAuth
                ? await this.ensureAuth()
                : await account.ensureAuth();
              return await operation(refreshedAuth, attempt, account);
            }
          },
          { label, model },
        );
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error)) {
          const cooldownUntil = parseRateLimitCooldown(error);
          account.rateLimitedUntil = cooldownUntil;
          const waitMinutes = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 60000));
          console.warn(
            `[${nowIso()}] account ${account.identifier} hit rate limit (HTTP 429, resets in ~${waitMinutes}m). Rotating to next account...`,
          );
          continue;
        }
        throw error;
      }
    }

    if (isRateLimitError(lastError)) {
      throw this.buildAllAccountsRateLimitedError();
    }
    throw lastError || new Error("All accounts failed.");
  }

  cacheModelSettings(models) {
    const settings = new Map();
    for (const model of Array.isArray(models) ? models : []) {
      const entry = {};
      if (typeof model?.settings?.temperature === "number") {
        entry.temperature = model.settings.temperature;
      }
      if (typeof model?.settings?.topP === "number") {
        entry.topP = model.settings.topP;
      }
      if (typeof model?.largeContextChatEligible === "boolean") {
        entry.largeContextChatEligible = model.largeContextChatEligible;
      }
      if (typeof model?.usesCredits === "boolean") {
        entry.usesCredits = model.usesCredits;
      }
      if (Object.keys(entry).length === 0) {
        continue;
      }
      for (const id of [model.id, model.apiModelId, ...(model.aliasIds ?? [])]) {
        if (typeof id === "string" && id) {
          settings.set(id, entry);
        }
      }
    }

    // A catalog fetch that yields nothing usable keeps the previous defaults
    // rather than silently reverting every model to Venice's server-side ones.
    if (settings.size === 0) {
      return this.modelSettings;
    }

    this.modelSettings = settings;
    this.modelSettingsLoadedAt = Date.now();
    debugLog("models:settings", { cached: settings.size });
    return settings;
  }

  getModelSettings(model) {
    if (typeof model !== "string" || !model) {
      return null;
    }
    return this.modelSettings.get(model) ?? null;
  }

  async fetchTextModels() {
    const models = await this.callWithAuth(
      async (auth, attempt, account) =>
        await (account?.client ?? this.client).getTextModels(auth.login.clerkJwt, {
          matureFilter: false,
          onlySafeVenice: false,
        }),
      { label: "models", model: "n/a" },
    );
    this.cacheModelSettings(models);
    return models;
  }

  async refreshModelSettings() {
    await this.fetchTextModels();
    console.log(
      `[${nowIso()}] model catalog loaded: ${this.modelSettings.size} model settings cached (sampling defaults, large-context flags)`,
    );
    return this.modelSettings;
  }

  async getModels(options = {}) {
    const { onlyFree = false } = options || {};
    const models = await this.fetchTextModels();
    const data = models
      .filter(
        (model) =>
          model &&
          model.active !== false &&
          model.type === "text" &&
          (!onlyFree || model.usesCredits === false),
      )
      .map((model) => ({
        id: model.apiModelId || model.id,
        object: "model",
        created: Math.floor((model.releasedAt || Date.now()) / 1000),
        owned_by: "venice-web",
        permission: [],
        root: model.apiModelId || model.id,
        parent: null,
        venice: {
          id: model.id,
          friendly_name: model.friendly_name,
          model_traits: model.apiModelTraits || [],
        },
      }));

    // Agent-endpoint models are missing from the catalog, so list them by hand.
    for (const id of this.agentic.agentEndpointModels()) {
      if (data.some((model) => model.id === id)) {
        continue;
      }
      data.push({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "venice-web",
        permission: [],
        root: id,
        parent: null,
        venice: { id, friendly_name: id, model_traits: [] },
      });
    }
    return data;
  }

  async chatCompletions(payload) {
    const { prompt, systemPrompt } = splitMessages(payload.messages);
    if (prompt.length === 0) {
      throw new Error("No usable prompt messages found.");
    }

    const model = payload.model || this.client.model;
    return await this.callWithAuth(
      async (auth, attempt, account) => {
        const requestId = Math.random().toString(36).slice(2, 9);
        const options = buildVeniceChatOptions({
          payload,
          model,
          prompt,
          systemPrompt,
          requestId,
          resolveModelSettings: (id) => this.getModelSettings(id),
        });
        const targetClient = account?.client ?? this.client;
        const result = await targetClient.chat(auth.login.clerkJwt, undefined, options);
        return { ...result, promptTokens: estimatePromptTokens(options.promptMessages, options.systemPrompt) };
      },
      { label: "chat completion", model },
    );
  }

  async openChatCompletionStream(payload, toolEmulation = null) {
    const { prompt, systemPrompt } = splitMessages(toolEmulation?.messages ?? payload.messages);
    if (prompt.length === 0) {
      throw new Error("No usable prompt messages found.");
    }

    const model = payload.model || this.client.model;
    return await this.callWithAuth(
      async (auth, attempt, account) => {
        const requestId = Math.random().toString(36).slice(2, 9);
        const options = buildVeniceChatOptions({
          payload,
          model,
          prompt,
          systemPrompt,
          requestId,
          resolveModelSettings: (id) => this.getModelSettings(id),
          toolEmulation,
        });
        const targetClient = account?.client ?? this.client;
        const stream = await targetClient.openChatStream(auth.login.clerkJwt, undefined, options);
        return { ...stream, promptTokens: estimatePromptTokens(options.promptMessages, options.systemPrompt) };
      },
      { label: "chat completion stream", model },
    );
  }
}

export function createVeniceOpenAiProxy(sessionFiles) {
  return new VeniceOpenAiProxy(sessionFiles);
}

// Normalized upstream events for one emulated attempt on the chat endpoint.
async function* chatAttemptEvents(proxy, payload, toolEmulation, messages, stats) {
  const created = Math.floor(Date.now() / 1000);
  const stream = await proxy.openChatCompletionStream(payload, { ...toolEmulation, messages });
  // The usage reported is that of the attempt the reply came from.
  stats.promptTokens = stream.promptTokens;
  stats.completion = createTokenCounter();
  // What the proxy drops on the floor: other event kinds, non-JSON lines, and
  // unexpected fields on content events. Logged once, so a model whose tool
  // calls never show up as content can be diagnosed without a full dump.
  const ignored = new Map();
  const noteIgnored = (label) => ignored.set(label, (ignored.get(label) ?? 0) + 1);
  try {
    for await (const event of stream.events) {
      if (event?.kind !== "meta" && event?.kind !== "content") {
        noteIgnored(typeof event === "object" && event !== null ? `kind:${event.kind}` : `non-json:${JSON.stringify(String(event).slice(0, 40))}`);
      } else if (event.kind === "content") {
        for (const key of Object.keys(event)) {
          if (!["kind", "content", "reasoning_content"].includes(key)) {
            noteIgnored(`content.${key}`);
          }
        }
      }
      yield* normalizeChatEvent(event, stats, created);
    }
  } finally {
    if (ignored.size > 0) {
      console.warn(
        `[${nowIso()}] tool emulation: ignored upstream events model=${payload.model} ${[...ignored]
          .map(([label, count]) => `${label}×${count}`)
          .join(" ")}`,
      );
    }
  }
}

// One upstream chat event as runToolEmulation events.
function* normalizeChatEvent(event, stats, created) {
  updateStreamStats(stats, event);
  if (event?.kind === "content") {
    stats.completion?.add(event.content);
    stats.completion?.add(event.reasoning_content);
  }
  debugLog("venice:event", event);
  if (event?.kind === "meta") {
    yield {
      type: "meta",
      completionId:
        typeof event.completion_id === "string" ? toChatCompletionId(event.completion_id, created) : undefined,
      model: typeof event.servingModelId === "string" ? event.servingModelId : undefined,
    };
    return;
  }
  if (event?.kind !== "content") {
    return;
  }
  if (typeof event.reasoning_content === "string" && event.reasoning_content !== "") {
    yield { type: "reasoning", text: event.reasoning_content };
  }
  if (typeof event.content === "string" && event.content !== "") {
    yield { type: "content", text: event.content };
  }
}

// /v1/chat/completions for a request with tools, streaming or not. Both modes
// read the upstream as a stream so a finished reply can cut it short and an
// unparsed call can be retried before anything about it is sent.
async function respondWithToolEmulation({ req, res, url, startedAt, proxy, payload, toolEmulation }) {
  const created = Math.floor(Date.now() / 1000);
  // Diagnostics for check:tools: with "x-venice-tool-debug: 1" the response
  // reports how many upstream attempts the reply took (2 after a retry).
  const reportAttempts = req.headers["x-venice-tool-debug"] === "1";
  let completionId = `chatcmpl_${created}`;
  let model = payload.model || proxy.client.model;
  const stats = createStreamStats();
  const runStats = {};
  const events = runToolEmulation({
    emulation: toolEmulation,
    openAttempt: (messages) => chatAttemptEvents(proxy, payload, toolEmulation, messages, stats),
    onEvent: (event) => logToolEmulationEvent(event, model),
    stats: runStats,
    reasoningBudget: TOOL_REASONING_BUDGET,
  });
  const logDone = (streamStartedAt = null, status = 200) =>
    logOutgoingResponse({
      req,
      url,
      status,
      model,
      contentLength: stats.contentLength,
      reasoningLength: stats.reasoningLength,
      toolCount: toolEmulation.tools.length,
      toolCallCount: runStats.toolCalls ?? 0,
      toolAttempts: runStats.attempts ?? 1,
      durationMs: Date.now() - startedAt,
      streamDurationMs: streamStartedAt === null ? null : Date.now() - streamStartedAt,
    });
  const applyMeta = (event) => {
    completionId = event.completionId ?? completionId;
    model = event.model ?? model;
  };
  const usage = () => buildUsage(stats.promptTokens, stats.completion?.tokens);

  if (!payload.stream) {
    let text = "";
    let reasoning = "";
    let failure = null;
    const toolCalls = [];
    for await (const event of events) {
      if (event.type === "error") {
        failure = event;
      } else if (event.type === "meta") {
        applyMeta(event);
      } else if (event.type === "reasoning") {
        reasoning += event.text;
      } else if (event.type === "text") {
        text += event.text;
      } else if (event.type === "tool_call") {
        toolCalls.push(event.toolCall);
      }
    }
    if (failure) {
      json(res, 504, { error: { message: failure.message, type: "server_error", code: failure.code } });
      logOutgoingResponse({
        req,
        url,
        status: 504,
        model,
        contentLength: stats.contentLength,
        reasoningLength: stats.reasoningLength,
        toolCount: toolEmulation.tools.length,
        toolCallCount: 0,
        toolAttempts: runStats.attempts ?? 1,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    const response = buildChatCompletionResponse({
      requestModel: model,
      completionId,
      text: toolCalls.length > 0 ? text.trim() || null : text,
      created,
      toolCalls,
      usage: usage(),
    });
    if (reasoning) {
      response.choices[0].message.reasoning_content = reasoning;
    }
    if (reportAttempts) {
      response.venice_tool_attempts = runStats.attempts;
    }
    json(res, 200, response);
    logDone();
    return;
  }

  const streamStartedAt = Date.now();
  let firstDeltaSent = false;
  let toolCallIndex = 0;
  let streamError = null;
  // Headers go out with the first chunk, so a failure to open the upstream
  // still becomes a JSON error.
  const writeDelta = (delta) => {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }
    const chunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: firstDeltaSent ? delta : { role: "assistant", ...delta },
          finish_reason: null,
          logprobs: null,
        },
      ],
      usage: null,
    };
    firstDeltaSent = true;
    debugLog("openai:chunk", chunk);
    writeSseChunk(res, chunk);
  };

  try {
    for await (const event of events) {
      if (event.type === "meta") {
        if (!firstDeltaSent) {
          applyMeta(event);
        }
      } else if (event.type === "reasoning") {
        writeDelta({ content: null, reasoning_content: event.text });
      } else if (event.type === "text") {
        writeDelta({ content: event.text, reasoning_content: null });
      } else if (event.type === "tool_call") {
        for (const delta of buildToolCallDeltas(event.toolCall, toolCallIndex)) {
          writeDelta(delta);
        }
        toolCallIndex += 1;
      } else if (event.type === "error") {
        streamError = event;
      }
    }

    if (streamError) {
      // invalid_request_error is the only error type that stops opencode's
      // retry loop: with server_error or model_error it re-sent the request
      // about ten times (opencode 2.2.3). The proxy has already spent its own
      // retry, so more rounds would only repeat the overrun for minutes.
      const error = { message: streamError.message, type: "invalid_request_error", code: streamError.code };
      const status = res.headersSent ? 200 : 504;
      if (!res.headersSent) {
        json(res, 504, { error });
      } else {
        // OpenAI-style mid-stream error: clients raise it instead of waiting.
        writeSseChunk(res, { error });
        res.write("data: [DONE]\n\n");
        res.end();
      }
      logDone(streamStartedAt, status);
      return;
    }

    if (!firstDeltaSent) {
      writeDelta({ content: null, reasoning_content: null });
    }
    const finishChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: "", reasoning_content: null },
          finish_reason: toolCallIndex > 0 ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage: null,
    };
    if (reportAttempts) {
      finishChunk.venice_tool_attempts = runStats.attempts;
    }
    writeSseChunk(res, finishChunk);
    writeSseChunk(res, { id: completionId, object: "chat.completion.chunk", created, model, choices: [], usage: usage() });
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      throw error;
    }
    console.warn(
      `[${nowIso()}] tool emulation stream failed model=${model}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    res.end();
  }
  logDone(streamStartedAt);
}

export function createVeniceOpenAiProxyServer(
  proxy = createVeniceOpenAiProxy(),
) {
  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    applyCorsHeaders(req, res);
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );

      if (req.method === "OPTIONS") {
        logIncomingRequest(req, url, 0);
        res.writeHead(204);
        res.end();
        logOutgoingResponse({
          req,
          url,
          status: 204,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/support/info" || url.pathname === "/v1/support/info")
      ) {
        logIncomingRequest(req, url, 0);
        json(res, 200, buildSupportInfo(proxy));
        logOutgoingResponse({
          req,
          url,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (
        req.method === "GET" &&
        (url.pathname === "/models" || url.pathname === "/v1/models")
      ) {
        logIncomingRequest(req, url, 0);
        const data = await proxy.getModels({ onlyFree: true });
        json(res, 200, { object: "list", data });
        logOutgoingResponse({
          req,
          url,
          status: 200,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/responses" || url.pathname === "/v1/responses")
      ) {
        const bodyText = await readBody(req);
        logIncomingRequest(req, url, getRequestLength(req, bodyText));
        const payload = safeJsonParse(bodyText);
        if (!payload || typeof payload !== "object") {
          json(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
          logOutgoingResponse({ req, url, status: 400, durationMs: Date.now() - startedAt });
          return;
        }
        if (!payload.input || (typeof payload.input !== "string" && !Array.isArray(payload.input))) {
          json(res, 400, { error: { message: "`input` is required (string or array)", type: "invalid_request_error" } });
          logOutgoingResponse({ req, url, status: 400, durationMs: Date.now() - startedAt });
          return;
        }

        // Models only the agents endpoint serves go there; everything else keeps
        // using the workflow endpoint, as before.
        const target =
          proxy.agentic.agentEndpointTarget(payload.model) ?? proxy.agentic.workflowTarget();
        const agentModelId = target.agentModelId;
        const stream = await proxy.callWithAuth(
          async (auth, attempt, account) =>
            await (account?.agentic ?? proxy.agentic).openStream(auth.login.clerkJwt, payload.input, target),
          { label: "responses", model: agentModelId },
        );
        const created = Math.floor(Date.now() / 1000);
        const translator = createResponsesTranslator({ model: agentModelId, created });
        let contentLength = 0;
        let reasoningLength = 0;
        const countDelta = (out) => {
          if (out.event === "response.output_text.delta") {
            contentLength += getTextLength(out.data?.delta);
          } else if (out.event === "response.reasoning_summary_text.delta") {
            reasoningLength += getTextLength(out.data?.delta);
          }
        };

        if (payload.stream) {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });

          try {
            for await (const sseEvent of stream.events) {
              debugLog("workflow:event", sseEvent);
              const translated = translator.translate(sseEvent);
              if (translated.length === 0) {
                debugLog("responses:forward", "[skip]");
              }
              for (const out of translated) {
                countDelta(out);
                debugLog("responses:forward", out.event);
                // OpenAI clients read the event name from the payload's `type`,
                // which outerface only sends on the SSE `event:` line.
                res.write(
                  `event: ${out.event}\ndata: ${JSON.stringify({ type: out.event, ...out.data })}\n\n`,
                );
              }
            }

            res.write("data: [DONE]\n\n");
            res.end();
          } catch (error) {
            console.warn(
              `[${nowIso()}] responses stream failed model=${agentModelId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            if (!res.writableEnded) res.end();
          }
          logOutgoingResponse({ req, url, status: 200, model: agentModelId, contentLength, reasoningLength, durationMs: Date.now() - startedAt });
          return;
        }

        // Non-streaming: fold the stream into a single response object.
        try {
          for await (const sseEvent of stream.events) {
            debugLog("workflow:event", sseEvent);
            translator.translate(sseEvent).forEach(countDelta);
          }
        } catch (error) {
          // A partial result is still returned, but nothing at all is an error.
          if (translator.snapshot().output.length === 0) throw error;
          console.warn(
            `[${nowIso()}] responses stream failed model=${agentModelId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }

        const response = translator.snapshot();
        if (response.status !== "completed") {
          response.status = "incomplete";
        }
        json(res, 200, response);
        logOutgoingResponse({ req, url, status: 200, model: agentModelId, contentLength, reasoningLength, durationMs: Date.now() - startedAt });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/chat/completions" ||
          url.pathname === "/v1/chat/completions")
      ) {
        const bodyText = await readBody(req);
        logIncomingRequest(req, url, getRequestLength(req, bodyText));
        const payload = safeJsonParse(bodyText);
        if (!payload || typeof payload !== "object") {
          json(res, 400, {
            error: {
              message: "Invalid JSON body",
              type: "invalid_request_error",
            },
          });
          logOutgoingResponse({
            req,
            url,
            status: 400,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
          json(res, 400, {
            error: {
              message: "`messages` is required",
              type: "invalid_request_error",
            },
          });
          logOutgoingResponse({
            req,
            url,
            status: 400,
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        // ── Agentic branch: workflow/chat when model === AGENTIC_MODEL_NAME, and
        // chat/agents/venice for the models only that endpoint serves ──
        const agentTarget =
          payload.model === AGENTIC_MODEL_NAME
            ? proxy.agentic.workflowTarget()
            : proxy.agentic.agentEndpointTarget(payload.model);

        // Requests with usable tools (and emulation on) take their own path;
        // everything below is the unchanged tool-less handling.
        const toolEmulation = resolveToolEmulation(payload, {
          enabled: TOOL_EMULATION_ENABLED,
          model: payload.model ?? proxy.client.model,
          formatRules: TOOL_FORMAT_RULES.rules,
        });
        if (toolEmulation && agentTarget) {
          // Venice's agent endpoints route tool calls to their own server-side
          // functions ("Tool not found") and run no client tools, so emulation
          // fails there; say so instead of answering badly.
          json(res, 400, {
            error: {
              message: `Tool calling is not supported for model "${payload.model}": Venice's agent endpoint only runs its own server-side tools. Use a chat model, or send the request without tools.`,
              type: "invalid_request_error",
              param: "tools",
              code: "tools_not_supported",
            },
          });
          logOutgoingResponse({ req, url, status: 400, model: agentTarget.agentModelId, durationMs: Date.now() - startedAt });
          return;
        }
        if (toolEmulation) {
          await respondWithToolEmulation({ req, res, url, startedAt, proxy, payload, toolEmulation });
          return;
        }

        if (agentTarget) {
          const agentModelId = agentTarget.agentModelId;
          // The session keeps the outerface connection open until
          // response.completed status=completed, and automatically re-enters
          // with reconstructed history if the stream closes prematurely (e.g. a
          // connection drop mid-tool-call).
          const agentEvents = await proxy.callWithAuth(
            async (auth, attempt, account) =>
              await (account?.agentic ?? proxy.agentic).openSession(auth.login.clerkJwt, payload.messages, agentTarget),
            { label: "agent chat completion", model: agentModelId },
          );
          const created = Math.floor(Date.now() / 1000);
          let completionId = `chatcmpl_${created}`;
          // The agent session builds its own prompt; the client's messages are
          // the closest estimate. Output counts the text the client receives.
          const promptTokens = estimatePromptTokens(payload.messages);
          const completion = createTokenCounter();
          // Track which output_index holds reasoning vs message content
          const itemTypes = {}; // output_index -> item type string

          if (payload.stream) {
            const streamStartedAt = Date.now();
            let firstDeltaSent = false;
            let contentLength = 0;
            let reasoningLength = 0;

            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });

            try {
              for await (const sseEvent of agentEvents) {
                const { event, data } = sseEvent;
                debugLog("workflow:event", sseEvent);

                if (event === "response.created" && data?.response?.id) {
                  completionId = data.response.id.replace(/^resp_/, "chatcmpl_");
                }

                if (event === "response.output_item.added") {
                  itemTypes[data?.output_index ?? 0] = data?.item?.type ?? "message";
                  debugLog("openai:chunk", "[skip]");
                  continue;
                }

                if (event === "response.output_text.delta") {
                  const idx = data?.output_index ?? 0;
                  const isReasoning = itemTypes[idx] === "reasoning";
                  const delta = data?.delta;
                  if (typeof delta !== "string" || delta === "") {
                    debugLog("openai:chunk", "[skip]");
                    continue;
                  }

                  if (isReasoning) {
                    reasoningLength += delta.length;
                  } else {
                    contentLength += delta.length;
                  }
                  completion.add(delta);

                  const deltaObj = firstDeltaSent
                    ? (isReasoning
                        ? { content: null, reasoning_content: delta }
                        : { content: delta, reasoning_content: null })
                    : (isReasoning
                        ? { role: "assistant", content: null, reasoning_content: delta }
                        : { role: "assistant", content: delta, reasoning_content: null });
                  firstDeltaSent = true;

                  const chunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: agentModelId,
                    choices: [{ index: 0, delta: deltaObj, finish_reason: null, logprobs: null }],
                    usage: null,
                  };
                  debugLog("openai:chunk", chunk);
                  writeSseChunk(res, chunk);
                  continue;
                }

                // Human-readable search progress line in reasoning_content.
                if (event === "veniceai:web_search_call.searching" && typeof data?.query === "string") {
                  const notification = `\n[web_search: "${data.query}"]\n`;
                  reasoningLength += notification.length;
                  const deltaObj = firstDeltaSent
                    ? { content: null, reasoning_content: notification }
                    : { role: "assistant", content: null, reasoning_content: notification };
                  firstDeltaSent = true;
                  const chunk = {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: agentModelId,
                    choices: [{ index: 0, delta: deltaObj, finish_reason: null, logprobs: null }],
                    usage: null,
                  };
                  debugLog("openai:chunk", chunk);
                  writeSseChunk(res, chunk);
                  continue;
                }

                // Machine-readable turn history — emitted at end of outerface session.
                // Encodes reasoning items + function_call/function_call_output items so
                // a subsequent turn can reconstruct the full workflow context.
                if (event === "__vc:session_done__") {
                  const items = data?.items;
                  if (Array.isArray(items) && items.length > 0) {
                    const encoded = Buffer.from(JSON.stringify(items)).toString("base64");
                    const marker = `[__vc_hist__]${encoded}[/__vc_hist__]`;
                    reasoningLength += marker.length;
                    const deltaObj = firstDeltaSent
                      ? { content: null, reasoning_content: marker }
                      : { role: "assistant", content: null, reasoning_content: marker };
                    firstDeltaSent = true;
                    const chunk = {
                      id: completionId,
                      object: "chat.completion.chunk",
                      created,
                      model: agentModelId,
                      choices: [{ index: 0, delta: deltaObj, finish_reason: null, logprobs: null }],
                      usage: null,
                    };
                    debugLog("openai:chunk", chunk);
                    writeSseChunk(res, chunk);
                  }
                  debugLog("openai:chunk", "[skip]");
                  continue;
                }

                debugLog("openai:chunk", "[skip]");
              }

              writeSseChunk(res, {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: agentModelId,
                choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: "stop", logprobs: null }],
                usage: null,
              });
              writeSseChunk(res, {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: agentModelId,
                choices: [],
                usage: buildUsage(promptTokens, completion.tokens),
              });
              res.write("data: [DONE]\n\n");
              res.end();
              logOutgoingResponse({ req, url, status: 200, model: agentModelId, contentLength, reasoningLength, durationMs: Date.now() - startedAt, streamDurationMs: Date.now() - streamStartedAt });
            } catch (error) {
              if (!res.headersSent) throw error;
              console.warn(
                `[${nowIso()}] agent stream failed model=${agentModelId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              res.end();
              logOutgoingResponse({ req, url, status: 200, model: agentModelId, contentLength, reasoningLength, durationMs: Date.now() - startedAt, streamDurationMs: Date.now() - streamStartedAt });
            }
            return;
          }

          // Non-streaming agentic: collect all deltas, return a single chat.completion
          let fullContent = "";
          let fullReasoning = "";
          try {
            for await (const sseEvent of agentEvents) {
              const { event, data } = sseEvent;
              debugLog("workflow:event", sseEvent);

              if (event === "response.created" && data?.response?.id) {
                completionId = data.response.id.replace(/^resp_/, "chatcmpl_");
              }
              if (event === "response.output_item.added") {
                itemTypes[data?.output_index ?? 0] = data?.item?.type ?? "message";
              }
              if (event === "response.output_text.delta" && typeof data?.delta === "string") {
                completion.add(data.delta);
                const idx = data?.output_index ?? 0;
                if (itemTypes[idx] === "reasoning") {
                  fullReasoning += data.delta;
                } else {
                  fullContent += data.delta;
                }
              }
              if (event === "veniceai:web_search_call.searching" && typeof data?.query === "string") {
                fullReasoning += `\n[web_search: "${data.query}"]\n`;
              }
              if (event === "__vc:session_done__") {
                const items = data?.items;
                if (Array.isArray(items) && items.length > 0) {
                  const encoded = Buffer.from(JSON.stringify(items)).toString("base64");
                  fullReasoning += `[__vc_hist__]${encoded}[/__vc_hist__]`;
                }
              }
            }
          } catch (error) {
            // partial result is fine
            console.warn(
              `[${nowIso()}] agent stream failed model=${agentModelId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }

          const message = { role: "assistant", content: fullContent };
          if (fullReasoning) message.reasoning_content = fullReasoning;
          json(res, 200, {
            id: completionId,
            object: "chat.completion",
            created,
            model: agentModelId,
            choices: [{ index: 0, finish_reason: "stop", message }],
            usage: buildUsage(promptTokens, completion.tokens),
          });
          logOutgoingResponse({ req, url, status: 200, model: agentModelId, contentLength: fullContent.length, reasoningLength: fullReasoning.length, durationMs: Date.now() - startedAt });
          return;
        }
        // ── End agentic branch ──

        if (payload.stream) {
          const streamStartedAt = Date.now();
          const created = Math.floor(Date.now() / 1000);
          let completionId = `chatcmpl_${created}`;
          let servingModelId = payload.model || proxy.client.model;
          let firstDeltaSent = false;
          const stats = createStreamStats();
          const stream = await proxy.openChatCompletionStream(payload);
          const completion = createTokenCounter();

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });

          try {
            for await (const event of stream.events) {
              updateStreamStats(stats, event);
              if (event?.kind === "content") {
                completion.add(event.content);
                completion.add(event.reasoning_content);
              }
              debugLog("venice:event", event);

              if (
                event?.kind === "meta" &&
                typeof event.completion_id === "string"
              ) {
                completionId = toChatCompletionId(event.completion_id, created);
              }
              if (
                event?.kind === "meta" &&
                typeof event.servingModelId === "string"
              ) {
                servingModelId = event.servingModelId;
              }

              if (event?.kind !== "content") {
                debugLog("openai:chunk", "[skip]");
                continue;
              }

              const contentVal =
                typeof event.content === "string" && event.content !== ""
                  ? event.content
                  : null;
              const reasoningVal =
                typeof event.reasoning_content === "string" &&
                event.reasoning_content !== ""
                  ? event.reasoning_content
                  : null;

              if (contentVal === null && reasoningVal === null) {
                debugLog("openai:chunk", "[skip]");
                continue;
              }

              const delta = firstDeltaSent
                ? { content: contentVal, reasoning_content: reasoningVal }
                : {
                    content: contentVal,
                    reasoning_content: reasoningVal,
                    role: "assistant",
                  };
              firstDeltaSent = true;

              const chunk = {
                choices: [
                  { delta, finish_reason: null, index: 0, logprobs: null },
                ],
                object: "chat.completion.chunk",
                usage: null,
                created,
                model: servingModelId,
                id: completionId,
              };
              debugLog("openai:chunk", chunk);
              writeSseChunk(res, chunk);
            }

            if (!firstDeltaSent) {
              writeSseChunk(res, {
                choices: [
                  {
                    delta: {
                      content: null,
                      reasoning_content: null,
                      role: "assistant",
                    },
                    finish_reason: null,
                    index: 0,
                    logprobs: null,
                  },
                ],
                object: "chat.completion.chunk",
                usage: null,
                created,
                model: servingModelId,
                id: completionId,
              });
            }

            writeSseChunk(res, {
              choices: [
                {
                  finish_reason: "stop",
                  delta: { content: "", reasoning_content: null },
                  index: 0,
                  logprobs: null,
                },
              ],
              object: "chat.completion.chunk",
              usage: null,
              created,
              model: servingModelId,
              id: completionId,
            });
            writeSseChunk(res, {
              choices: [],
              object: "chat.completion.chunk",
              usage: buildUsage(stream.promptTokens, completion.tokens),
              created,
              model: servingModelId,
              id: completionId,
            });
            res.write("data: [DONE]\n\n");
            res.end();
            logOutgoingResponse({
              req,
              url,
              status: 200,
              model: servingModelId,
              contentLength: stats.contentLength,
              reasoningLength: stats.reasoningLength,
              durationMs: Date.now() - startedAt,
              streamDurationMs: Date.now() - streamStartedAt,
            });
            return;
          } catch (error) {
            if (!res.headersSent) {
              throw error;
            }
            res.end();
            logOutgoingResponse({
              req,
              url,
              status: 200,
              model: servingModelId,
              contentLength: stats.contentLength,
              reasoningLength: stats.reasoningLength,
              durationMs: Date.now() - startedAt,
              streamDurationMs: Date.now() - streamStartedAt,
            });
            return;
          }
        }

        const result = await proxy.chatCompletions(payload);
        const created = Math.floor(Date.now() / 1000);
        const completionId = toChatCompletionId(
          result.events.find(
            (event) => event?.kind === "meta" && event?.completion_id,
          )?.completion_id,
          created,
        );
        const servingModelId =
          result.events.find(
            (event) => event?.kind === "meta" && event?.servingModelId,
          )?.servingModelId || payload.model;
        const lengths = collectStreamLengths(result.events);

        json(
          res,
          200,
          buildChatCompletionResponse({
            requestModel: servingModelId,
            completionId,
            text: result.text,
            created,
            usage: buildUsage(result.promptTokens, estimateCompletionTokens(result.events)),
          }),
        );
        logOutgoingResponse({
          req,
          url,
          status: 200,
          model: servingModelId,
          contentLength: lengths.contentLength,
          reasoningLength: lengths.reasoningLength,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      logIncomingRequest(req, url, 0);
      json(res, 404, {
        error: { message: "Not found", type: "invalid_request_error" },
      });
      logOutgoingResponse({
        req,
        url,
        status: 404,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      const overflow = contextOverflowError(error);
      if (overflow) {
        console.warn(`[${nowIso()}] context overflow: ${error instanceof Error ? error.message : String(error)}`);
        json(res, overflow.status, overflow.body);
        logOutgoingResponse({ req, url, status: overflow.status, durationMs: Date.now() - startedAt });
        return;
      }
      if (error instanceof AllAccountsRateLimitedError) {
        const retryAfterSeconds = error.retryAfterSeconds;
        res.setHeader("x-should-retry", "false");
        if (retryAfterSeconds) {
          res.setHeader("retry-after", String(retryAfterSeconds));
        }
        json(res, 400, {
          error: {
            message:
              "Venice rate limit exceeded on all accounts (free quota reached). Not retrying; wait for the quota to reset.",
            type: "invalid_request_error",
            code: "all_accounts_rate_limited",
            reset_at: error.rateLimitedUntil
              ? new Date(error.rateLimitedUntil).toISOString()
              : null,
            retry_after_seconds: retryAfterSeconds,
          },
        });
        logOutgoingResponse({ req, url, status: 400, durationMs: Date.now() - startedAt });
        return;
      }
      const errStr = error instanceof Error ? error.message : String(error);
      if (errStr.startsWith("HTTP 429:")) {
        json(res, 429, {
          error: {
            message: "Venice rate limit exceeded (free quota reached). Please wait for quota reset.",
            type: "invalid_request_error",
            code: "rate_limit_exceeded",
          },
        });
        logOutgoingResponse({ req, url, status: 429, durationMs: Date.now() - startedAt });
        return;
      }
      json(res, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "server_error",
        },
      });
      logOutgoingResponse({
        req,
        url,
        status: 500,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

export function startVeniceOpenAiProxyServer({
  host = HOST,
  port = PORT,
  proxy = createVeniceOpenAiProxy(),
} = {}) {
  const server = createVeniceOpenAiProxyServer(proxy);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, async () => {
      server.off("error", reject);
      // A new session file joins the pool on the next poll; no restart needed.
      const watcher = proxy.watchAccounts(ACCOUNT_REFRESH_MS);
      if (watcher) {
        console.log(
          `[${nowIso()}] watching for account changes every ${ACCOUNT_REFRESH_MS}ms (set VENICE_ACCOUNT_REFRESH_MS=0 to disable)`,
        );
      }
      // Warm the sampling defaults so the first chat completion already matches
      // the web UI; a failure here must not keep the proxy from serving.
      try {
        await proxy.refreshModelSettings();
      } catch (error) {
        console.warn(
          `[${nowIso()}] could not load model catalog at startup: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      resolve({ server, proxy, host, port });
    });
    server.on("close", () => proxy.stopAccountWatcher());
  });
}

async function main() {
  const { host, port } = await startVeniceOpenAiProxyServer();
  console.log(`Venice OpenAI proxy listening on http://${host}:${port}` );
  debugLog("main", "Debug mode on!")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
