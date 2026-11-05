import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  buildUsage,
  contextOverflowError,
  createTokenCounter,
  estimatePromptTokens,
  estimateTokens,
} from "../src/context.mjs";
import { createVeniceOpenAiProxy, createVeniceOpenAiProxyServer } from "../src/proxy.mjs";

// Offline check of the context-size handling: estimated usage on every chat
// response, the enableLargeContextChat opt-in, and Venice's 413
// userPromptTooLong returned as a context-overflow 400. Runs the proxy with a
// stubbed Venice client; nothing leaves the machine.

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

const CATALOG = [
  { id: "zai-org-glm-5-2", largeContextChatEligible: true, usesCredits: false },
  { id: "qwen3-coder-480b-a35b-instruct-turbo", largeContextChatEligible: false, usesCredits: false },
  { id: "credit-model", largeContextChatEligible: true, usesCredits: true },
  { id: "sampling-only", settings: { temperature: 0.7 } },
];

function testHelpers() {
  section("helpers");
  ok("7 ASCII bytes → 2 tokens", estimateTokens("abcdefg") === 2, String(estimateTokens("abcdefg")));
  ok("empty and non-strings → 0", estimateTokens("") === 0 && estimateTokens(null) === 0 && estimateTokens(5) === 0);
  ok("multi-byte text counted in UTF-8 bytes", estimateTokens("привет") === Math.ceil(12 / 3.5));
  ok("prompt estimate walks nested strings",
    estimatePromptTokens([{ role: "user", content: "abcdefg" }], "abcdefg") ===
      estimateTokens("user") + 2 + 2);

  const counter = createTokenCounter();
  for (let i = 0; i < 70; i += 1) {
    counter.add("a");
  }
  counter.add(undefined);
  counter.add(null);
  ok("counter sums bytes before rounding (70 one-byte deltas → 20)", counter.tokens === 20, String(counter.tokens));

  ok("usage object", JSON.stringify(buildUsage(10, 5)) ===
    JSON.stringify({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
  ok("usage tolerates missing values", JSON.stringify(buildUsage(undefined, null)) ===
    JSON.stringify({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));

  const overflow = contextOverflowError(new Error('HTTP 413: {"error":"userPromptTooLong"}'));
  ok("413 userPromptTooLong → 400 context_length_exceeded",
    overflow?.status === 400 && overflow.body.error.code === "context_length_exceeded" &&
      overflow.body.error.type === "invalid_request_error");
  // opencode's overflow regexes include /prompt is too long/i.
  ok("message matches opencode's overflow pattern", /prompt is too long/i.test(overflow?.body.error.message ?? ""));
  ok("pretty-printed 413 body also mapped",
    contextOverflowError(new Error('HTTP 413: {\n  "error": "userPromptTooLong"\n}'))?.status === 400);
  ok("413 userMessageTooLong also mapped",
    contextOverflowError(new Error('HTTP 413: {"error":"userMessageTooLong"}'))?.status === 400);
  ok("other errors not mapped",
    contextOverflowError(new Error('HTTP 500: {"error":"userPromptTooLong"}')) === null &&
      contextOverflowError(new Error("HTTP 413: Payload Too Large")) === null &&
      contextOverflowError(new Error("Too many requests")) === null &&
      contextOverflowError(undefined) === null);
}

function readSse(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

async function testProxy() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];

  const proxy = createVeniceOpenAiProxy();
  proxy.ensureAuth = async () => ({ login: { clerkJwt: "jwt" } });
  proxy.cacheModelSettings(CATALOG);

  // 70 bytes of content and 35 of reasoning → 20 + 10 = 30 tokens... counted
  // together: 105 bytes → 30.
  const REPLY = "x".repeat(70);
  const REASONING = "r".repeat(35);
  let sent = null;
  let failWith = null;
  let replyText = REPLY;
  const chatEvents = () => [
    { kind: "meta", completion_id: "abc", servingModelId: sent?.model },
    { kind: "content", content: "", reasoning_content: REASONING },
    ...[...replyText].map((char) => ({ kind: "content", content: char })),
  ];
  proxy.client.chat = async (_jwt, _input, options) => {
    sent = options;
    if (failWith) {
      throw failWith;
    }
    const events = chatEvents();
    return { events, text: replyText };
  };
  proxy.client.openChatStream = async (_jwt, _input, options) => {
    sent = options;
    if (failWith) {
      throw failWith;
    }
    const events = chatEvents();
    return { events: (async function* () { yield* events; })() };
  };
  const agentStream = (messages) => {
    sent = messages;
    if (failWith) {
      throw failWith;
    }
    return {
      events: (async function* () {
        yield { event: "response.output_item.added", data: { output_index: 0, item: { type: "reasoning" } } };
        yield { event: "response.output_text.delta", data: { output_index: 0, delta: REASONING } };
        yield { event: "response.output_item.added", data: { output_index: 1, item: { type: "message" } } };
        for (const char of REPLY) {
          yield { event: "response.output_text.delta", data: { output_index: 1, delta: char } };
        }
        yield { event: "response.completed", data: { response: { status: "completed" } } };
      })(),
    };
  };
  proxy.client.openAgentChatStream = async (_jwt, messages) => agentStream(messages);
  proxy.client.openWorkflowChatStream = async (_jwt, messages) => agentStream(messages);

  const server = createVeniceOpenAiProxyServer(proxy);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const post = async (body) => {
    sent = null;
    logs.length = 0;
    console.log = (line) => logs.push(String(line));
    console.warn = (line) => logs.push(String(line));
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  };
  // Usage from a JSON body, or from the last SSE chunk that carries one.
  const usageOf = (result, stream) => {
    if (!stream) {
      return JSON.parse(result.text).usage ?? null;
    }
    const chunks = readSse(result.text);
    const withUsage = chunks.filter((chunk) => chunk.usage);
    return { usage: withUsage.at(-1)?.usage ?? null, count: withUsage.length, last: chunks.at(-1) };
  };

  const messages = [
    { role: "system", content: "s".repeat(350) },
    { role: "user", content: "u".repeat(700) },
  ];
  const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];

  try {
    for (const stream of [false, true]) {
      section(`plain chat, stream=${stream}`);
      const result = await post({ model: "zai-org-glm-5-2", stream, messages });
      ok("request succeeds", result.status === 200, String(result.status));
      const expectedPrompt = estimatePromptTokens(sent.promptMessages, sent.systemPrompt);
      const usage = stream ? usageOf(result, true).usage : usageOf(result, false);
      ok("prompt_tokens is the estimate of what was sent upstream",
        usage?.prompt_tokens === expectedPrompt && expectedPrompt >= 300, JSON.stringify(usage));
      ok("completion_tokens counts content and reasoning (105 bytes → 30)",
        usage?.completion_tokens === 30, JSON.stringify(usage));
      ok("total_tokens adds up", usage?.total_tokens === usage?.prompt_tokens + usage?.completion_tokens);
      if (stream) {
        const sse = usageOf(result, true);
        ok("usage only on the final choices:[] chunk",
          sse.count === 1 && sse.last.usage && sse.last.choices.length === 0);
      }
      ok("translate log has est_prompt_tokens",
        logs.some((line) => line.includes(" translate ") && line.includes(`est_prompt_tokens=${expectedPrompt}`)));
    }

    for (const stream of [false, true]) {
      section(`emulated tools, stream=${stream}`);
      replyText = 'Checking.<tool_call>{"name": "get_weather", "arguments": {"city": "Paris"}}</tool_call>';
      const result = await post({ model: "zai-org-glm-5-2", stream, messages, tools });
      ok("request succeeds", result.status === 200, String(result.status));
      const usage = stream ? usageOf(result, true).usage : usageOf(result, false);
      const expectedPrompt = estimatePromptTokens(sent.promptMessages, sent.systemPrompt);
      ok("prompt_tokens includes the injected tool prompt",
        usage?.prompt_tokens === expectedPrompt && expectedPrompt > estimatePromptTokens(messages), JSON.stringify(usage));
      const expectedCompletion = Math.ceil((Buffer.byteLength(replyText) + REASONING.length) / 3.5);
      ok("completion_tokens counts the raw upstream reply", usage?.completion_tokens === expectedCompletion,
        `${JSON.stringify(usage)} expected ${expectedCompletion}`);
      if (stream) {
        const sse = usageOf(result, true);
        ok("usage only on the final choices:[] chunk", sse.count === 1 && sse.last.choices.length === 0);
      } else {
        ok("tool call still returned", JSON.parse(result.text).choices[0].message.tool_calls?.length === 1);
      }
      replyText = REPLY;
    }

    for (const stream of [false, true]) {
      section(`agent endpoint, stream=${stream}`);
      const result = await post({ model: "deepseek-v4-1-flash-free", stream, messages });
      ok("request succeeds", result.status === 200, String(result.status));
      const usage = stream ? usageOf(result, true).usage : usageOf(result, false);
      ok("prompt_tokens estimated from the client messages",
        usage?.prompt_tokens === estimatePromptTokens(messages), JSON.stringify(usage));
      ok("completion_tokens counts the deltas (105 bytes → 30)", usage?.completion_tokens === 30, JSON.stringify(usage));
      if (stream) {
        const sse = usageOf(result, true);
        ok("usage only on the final choices:[] chunk", sse.count === 1 && sse.last.choices.length === 0);
      }
    }

    section("enableLargeContextChat");
    const lccFor = async (model, stream = false) => {
      await post({ model, stream, messages });
      return sent?.enableLargeContextChat;
    };
    ok("on for an LCC-eligible non-credit model", (await lccFor("zai-org-glm-5-2")) === true);
    ok("on for streaming too", (await lccFor("zai-org-glm-5-2", true)) === true);
    ok("not sent for a non-eligible model", (await lccFor("qwen3-coder-480b-a35b-instruct-turbo")) === undefined);
    ok("not sent for a credit (PPU) model", (await lccFor("credit-model")) === undefined);
    ok("not sent for a model without catalog flags", (await lccFor("sampling-only")) === undefined);
    ok("not sent for a model missing from the catalog", (await lccFor("unknown-model")) === undefined);
    await post({ model: "zai-org-glm-5-2", messages });
    ok("translate log notes large_context=on", logs.some((line) => line.includes("large_context=on")));
    await post({ model: "qwen3-coder-480b-a35b-instruct-turbo", messages });
    ok("no large_context note otherwise", !logs.some((line) => line.includes("large_context")));
    ok("sampling defaults still applied next to the flags", await (async () => {
      await post({ model: "sampling-only", messages });
      return sent?.temperature === 0.7;
    })());

    for (const [label, body] of [
      ["chat, stream=false", { model: "zai-org-glm-5-2", messages }],
      ["chat, stream=true", { model: "zai-org-glm-5-2", stream: true, messages }],
      ["emulated tools, stream=true", { model: "zai-org-glm-5-2", stream: true, messages, tools }],
      ["agent endpoint", { model: "deepseek-v4-1-flash-free", messages }],
    ]) {
      section(`413 userPromptTooLong, ${label}`);
      failWith = new Error('HTTP 413: {"error":"userPromptTooLong"}');
      const result = await post(body);
      failWith = null;
      const error = (() => {
        try {
          return JSON.parse(result.text).error;
        } catch {
          return null;
        }
      })();
      ok("HTTP 400", result.status === 400, `${result.status} ${result.text.slice(0, 120)}`);
      ok("code context_length_exceeded", error?.code === "context_length_exceeded");
      ok("logged as a context overflow", logs.some((line) => line.includes("context overflow")));
    }

    section("other upstream errors unchanged");
    failWith = new Error('HTTP 500: {"error":"boom"}');
    const result = await post({ model: "zai-org-glm-5-2", messages });
    failWith = null;
    ok("still a 500 server_error", result.status === 500 && JSON.parse(result.text).error.type === "server_error",
      `${result.status} ${result.text.slice(0, 120)}`);
  } finally {
    server.close();
  }
}

// The request body Venice receives, with the flag on and off.
async function testClientBody() {
  section("client request body");
  const proxy = createVeniceOpenAiProxy();
  const bodies = [];
  proxy.client.outerfaceHeaders = () => ({});
  proxy.client.request = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('{"kind":"content","content":"ok"}\n', { status: 200 });
  };
  const base = { promptMessages: [{ role: "user", content: "hi" }], model: "m" };
  await proxy.client.chat("jwt", undefined, { ...base, enableLargeContextChat: true });
  await proxy.client.chat("jwt", undefined, base);
  const stream = await proxy.client.openChatStream("jwt", undefined, { ...base, enableLargeContextChat: true });
  for await (const _event of stream.events) {
    // drain
  }
  await proxy.client.openChatStream("jwt", undefined, base);
  ok("chat(): flag sent when requested", bodies[0]?.enableLargeContextChat === true);
  ok("chat(): field absent otherwise", bodies[1] && !("enableLargeContextChat" in bodies[1]));
  ok("openChatStream(): flag sent when requested", bodies[2]?.enableLargeContextChat === true);
  ok("openChatStream(): field absent otherwise", bodies[3] && !("enableLargeContextChat" in bodies[3]));
}

// VENICE_LARGE_CONTEXT is read at startup, so it is checked in a child process.
function testEnvOff() {
  section("VENICE_LARGE_CONTEXT=off");
  const script = `
    import { createVeniceOpenAiProxy } from "./src/proxy.mjs";
    const proxy = createVeniceOpenAiProxy();
    proxy.ensureAuth = async () => ({ login: { clerkJwt: "jwt" } });
    proxy.cacheModelSettings(${JSON.stringify(CATALOG)});
    let sent = null;
    proxy.client.chat = async (_jwt, _input, options) => { sent = options; return { events: [], text: "" }; };
    console.log = () => {};
    await proxy.chatCompletions({ model: "zai-org-glm-5-2", messages: [{ role: "user", content: "hi" }] });
    process.stdout.write(JSON.stringify({ flag: sent?.enableLargeContextChat ?? null }));
  `;
  const run = (value) => {
    const env = { ...process.env };
    if (value === undefined) {
      delete env.VENICE_LARGE_CONTEXT;
    } else {
      env.VENICE_LARGE_CONTEXT = value;
    }
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
    });
    return JSON.parse(output.slice(output.lastIndexOf("{"))).flag;
  };
  ok("default: on", run(undefined) === true);
  ok("off disables it", run("off") === null);
  ok("0 / false / no disable it", run("0") === null && run("false") === null && run(" No ") === null);
  ok("other values keep it on", run("on") === true);
}

async function main() {
  testHelpers();
  await testProxy();
  await testClientBody();
  testEnvOff();
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
