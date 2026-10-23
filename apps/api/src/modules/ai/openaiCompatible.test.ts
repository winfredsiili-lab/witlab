import { describe, expect, it } from "vitest";
import { AiProviderError } from "./provider.js";
import { createOpenAiCompatibleProvider } from "./openaiCompatible.js";

const req = { system: "sys", user: "usr", schemaName: "cards", schema: { type: "object" }, maxOutputTokens: 100 };

function provider(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createOpenAiCompatibleProvider>[0]> = {}) {
  return createOpenAiCompatibleProvider({
    apiKey: "sk-secret-key", baseUrl: "https://ai.example/v1/", model: "m1", strictSchema: true,
    reasoningEffort: "low", timeoutMs: 1000, fetchImpl, ...extra,
  });
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const ok = (content: string, finish = "stop") => reply(200, { choices: [{ finish_reason: finish, message: { content } }] });
const failure = async (p: ReturnType<typeof provider>) => (await p.generateStructured(req).catch((e) => e)) as AiProviderError;

describe("OpenAI-compatible adapter", () => {
  it("sends the key as a bearer token, a strict json schema and the token cap; returns parsed JSON", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = provider((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"cards":[]}' } }] }));
    }) as unknown as typeof fetch);
    expect(await p.generateStructured(req)).toEqual({ cards: [] });
    expect(seen!.url).toBe("https://ai.example/v1/chat/completions");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-secret-key");
    const body = JSON.parse(seen!.init.body as string);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: "cards", strict: true, schema: { type: "object" } } });
    expect(body.max_completion_tokens).toBe(100);
    expect(body.reasoning_effort).toBe("low");
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("uses plain JSON mode and omits reasoning when configured", async () => {
    let body: Record<string, unknown> = {};
    const p = provider((async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "{}" } }] }));
    }) as unknown as typeof fetch, { strictSchema: false, reasoningEffort: "off" });
    await p.generateStructured(req);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("maps 429 to ai_rate_limited with the retry hint", async () => {
    const e = await failure(provider(reply(429, { error: { message: "slow down" } }, { "retry-after": "12" })));
    expect(e.code).toBe("ai_rate_limited");
    expect(e.retryAfterSeconds).toBe(12);
    expect(e.message).toMatch(/12 seconds/);
  });

  it.each([[401], [403]])("maps %i to ai_auth without leaking the key", async (status) => {
    const e = await failure(provider(reply(status, { error: { message: "bad key sk-secret-key" } })));
    expect(e.code).toBe("ai_auth");
    expect(e.message).not.toContain("sk-secret-key");
  });

  it("maps 5xx to ai_unavailable and other 4xx to ai_bad_response with the provider's reason", async () => {
    expect((await failure(provider(reply(503, {})))).code).toBe("ai_unavailable");
    const bad = await failure(provider(reply(400, { error: { message: "unknown parameter reasoning_effort" } })));
    expect(bad.code).toBe("ai_bad_response");
    expect(bad.message).toMatch(/unknown parameter/);
  });

  it("maps a network failure to ai_unavailable", async () => {
    const e = await failure(provider((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch));
    expect(e.code).toBe("ai_unavailable");
  });

  it("times out with ai_timeout (the request is really aborted)", async () => {
    let aborted = false;
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
      })) as unknown as typeof fetch;
    const e = await failure(provider(hang, { timeoutMs: 1000 }));
    expect(e.code).toBe("ai_timeout");
    expect(aborted).toBe(true);
  });

  it("treats finish_reason length as ai_truncated, never as usable output", async () => {
    expect((await failure(provider(ok('{"cards":[', "length")))).code).toBe("ai_truncated");
  });

  it("rejects empty, non-JSON and non-envelope replies as ai_bad_response", async () => {
    expect((await failure(provider(ok("")))).code).toBe("ai_bad_response");
    expect((await failure(provider(ok("not json")))).code).toBe("ai_bad_response");
    expect((await failure(provider(reply(200, { nothing: true })))).code).toBe("ai_bad_response");
    expect((await failure(provider((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch))).code).toBe("ai_bad_response");
  });
});
