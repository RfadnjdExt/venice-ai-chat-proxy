// Context-size helpers. Venice's web endpoints report no token usage, so the
// proxy estimates it; clients such as opencode compare usage.prompt_tokens with
// the model's context limit to decide when to compact a conversation, and see
// 0 without it.

// About 3.5 UTF-8 bytes per token: close for English and code, an overestimate
// for Cyrillic and other multi-byte text. Erring high makes clients compact a
// little early rather than run into Venice's limit.
const BYTES_PER_TOKEN = 3.5;

export function estimateTokens(text) {
  if (typeof text !== "string" || text === "") {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

// Estimated prompt size of what is sent to Venice: every string inside the
// prompt messages and the system prompt.
export function estimatePromptTokens(...parts) {
  let tokens = 0;
  const visit = (value) => {
    if (typeof value === "string") {
      tokens += estimateTokens(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  parts.forEach(visit);
  return tokens;
}

// Running count for streamed output. Bytes are summed and divided once at the
// end: rounding every small delta up separately would overcount by up to a
// token per chunk.
export function createTokenCounter() {
  let bytes = 0;
  return {
    add(text) {
      if (typeof text === "string") {
        bytes += Buffer.byteLength(text, "utf8");
      }
    },
    get tokens() {
      return Math.ceil(bytes / BYTES_PER_TOKEN);
    },
  };
}

// OpenAI-style usage object from estimated prompt and completion sizes.
export function buildUsage(promptTokens, completionTokens) {
  const prompt = Math.max(0, Math.round(promptTokens || 0));
  const completion = Math.max(0, Math.round(completionTokens || 0));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// Venice answers an over-long conversation with HTTP 413 {"error":"userPromptTooLong"}
// (also "userMessageTooLong" for a single message). Clients only compact when
// the error looks like a context overflow: a 4xx with code
// "context_length_exceeded" or a message such as "prompt is too long" (that is
// what opencode checks), so it is returned as such instead of a 500.
export function contextOverflowError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const match = /^HTTP 413: [\s\S]*"(userPromptTooLong|userMessageTooLong)"/.exec(message);
  if (!match) {
    return null;
  }
  return {
    status: 400,
    body: {
      error: {
        message: `prompt is too long: Venice rejected the request (${match[1]}). The conversation exceeds the maximum context length for this model; compact or shorten it.`,
        type: "invalid_request_error",
        param: "messages",
        code: "context_length_exceeded",
      },
    },
  };
}
