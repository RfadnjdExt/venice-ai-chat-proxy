import { pathToFileURL } from "node:url";
import { createVeniceOpenAiProxy, createVeniceOpenAiProxyServer } from "../src/proxy.mjs";
import { NULL_BYTE_REPLACEMENT, replaceNullBytes } from "../src/venice-text.mjs";

// Offline check: no null byte from a client message reaches Venice, on any
// endpoint. Runs the proxy server with a stubbed Venice client and inspects
// every outgoing request.

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

const NUL = "\u0000";
const hasNul = (value) => JSON.stringify(value).includes("\\u0000");

function testHelper() {
  section("replaceNullBytes");
  const counter = { replaced: 0 };
  const value = { a: `x${NUL}y`, list: [`${NUL}${NUL}`, 1, null, { deep: `z${NUL}` }], keep: "plain" };
  const result = replaceNullBytes(value, counter);
  ok("every null byte replaced, deep", !hasNul(result) && result.a === `x${NULL_BYTE_REPLACEMENT}y` &&
    result.list[0] === NULL_BYTE_REPLACEMENT.repeat(2) && result.list[3].deep === `z${NULL_BYTE_REPLACEMENT}`);
  ok("count of replacements", counter.replaced === 4, String(counter.replaced));
  ok("other values untouched", result.keep === "plain" && result.list[1] === 1 && result.list[2] === null);
  const clean = { a: "b", c: ["d"] };
  ok("clean input gives equal output", JSON.stringify(replaceNullBytes(clean)) === JSON.stringify(clean));
}

async function testProxy() {
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  const proxy = createVeniceOpenAiProxy();
  proxy.ensureAuth = async () => ({ login: { clerkJwt: "jwt" } });
  let sent = null;
  proxy.client.chat = async (_jwt, _input, options) => {
    sent = options;
    return { events: [{ kind: "content", content: "ok" }], text: "ok" };
  };
  proxy.client.openChatStream = async (_jwt, _input, options) => {
    sent = options;
    return { events: (async function* () { yield { kind: "content", content: "ok" }; })() };
  };
  const agentStream = (messages) => {
    sent = messages;
    return {
      events: (async function* () {
        yield { event: "response.completed", data: { response: { status: "completed" } } };
      })(),
    };
  };
  proxy.client.openAgentChatStream = async (_jwt, messages) => agentStream(messages);
  proxy.client.openWorkflowChatStream = async (_jwt, messages) => agentStream(messages);

  const server = createVeniceOpenAiProxyServer(proxy);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const post = async (path, body) => {
    sent = null;
    console.log = (line) => logs.push(String(line));
    console.warn = (line) => logs.push(String(line));
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await response.text();
      return response.status;
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  };

  // A tool result with `find -print0` output, a user message and a system
  // prompt that each carry null bytes.
  const messages = [
    { role: "system", content: `Be brief.${NUL}` },
    { role: "user", content: "list the files" },
    { role: "assistant", content: "Running find." },
    { role: "tool", tool_call_id: "c1", content: `./a.txt${NUL}./b.bin${NUL}` },
    { role: "user", content: `and this one: x${NUL}y` },
  ];

  try {
    for (const stream of [false, true]) {
      section(`chat endpoint, stream=${stream}`);
      logs.length = 0;
      const status = await post("/chat/completions", { model: "zai-org-glm-5-2", stream, messages });
      ok("request succeeds", status === 200, String(status));
      ok("no null byte sent upstream", sent && !hasNul(sent.promptMessages) && !hasNul(sent.systemPrompt));
      ok("null bytes replaced with U+FFFD in place",
        sent?.systemPrompt === `Be brief.${NULL_BYTE_REPLACEMENT}` &&
          sent?.promptMessages.some((message) => message.content.includes(`./a.txt${NULL_BYTE_REPLACEMENT}./b.bin${NULL_BYTE_REPLACEMENT}`)) &&
          sent?.promptMessages.at(-1).content === `and this one: x${NULL_BYTE_REPLACEMENT}y`);
      ok("translate log reports the replacements",
        logs.some((line) => line.includes(" translate ") && line.includes("null_bytes_replaced=4")));
    }

    section("chat endpoint, clean request");
    logs.length = 0;
    const clean = [{ role: "user", content: "hello" }];
    await post("/chat/completions", { model: "zai-org-glm-5-2", messages: clean });
    ok("clean prompt sent unchanged", JSON.stringify(sent?.promptMessages) === JSON.stringify(clean));
    ok("no replacement noted in the log", !logs.some((line) => line.includes("null_bytes_replaced")));

    section("agent endpoint");
    await post("/chat/completions", { model: "deepseek-v4-1-flash-free", messages });
    ok("no null byte in agent messages", Array.isArray(sent) && sent.length > 0 && !hasNul(sent));
    ok("replaced text kept in the agent messages", JSON.stringify(sent).includes(`x${NULL_BYTE_REPLACEMENT}y`));

    section("/v1/responses");
    await post("/responses", { input: [{ role: "user", content: `a${NUL}b` }] });
    ok("no null byte in responses input", Array.isArray(sent) && !hasNul(sent) &&
      JSON.stringify(sent).includes(`a${NULL_BYTE_REPLACEMENT}b`));
  } finally {
    server.close();
  }
}

async function main() {
  testHelper();
  await testProxy();
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
