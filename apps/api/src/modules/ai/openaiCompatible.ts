import { AiProviderError, type AiProvider, type StructuredRequest } from "./provider.js";

export interface OpenAiCompatibleOptions {
  apiKey: string;
  /** For example https://api.groq.com/openai/v1 (no trailing slash needed). */
  baseUrl: string;
  model: string;
  /** true: send a strict JSON schema. false: ask for plain JSON mode (models without schema support). */
  strictSchema: boolean;
  reasoningEffort: "low" | "medium" | "high" | "off";
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Reads the provider's own error message, if it sent one in the usual shape. Never includes request data. */
async function providerMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const m = body?.error?.message;
    return typeof m === "string" ? truncate(m) : "";
  } catch {
    return "";
  }
}

export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): AiProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    model: opts.model,

    async generateStructured(request: StructuredRequest): Promise<unknown> {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        temperature: 0.2,
        max_completion_tokens: request.maxOutputTokens,
        response_format: opts.strictSchema
          ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.schema } }
          : { type: "json_object" },
      };
      if (opts.reasoningEffort !== "off") body.reasoning_effort = opts.reasoningEffort;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          throw new AiProviderError("ai_timeout", `The AI service did not answer within ${Math.round(opts.timeoutMs / 1000)} seconds. Try again.`);
        }
        throw new AiProviderError("ai_unavailable", "The AI service could not be reached. Try again in a moment.");
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const detail = await providerMessage(res);
        if (res.status === 401 || res.status === 403) {
          throw new AiProviderError("ai_auth", "The AI service rejected the server's API key. The administrator needs to check AI_API_KEY.");
        }
        if (res.status === 429) {
          const retry = Number(res.headers.get("retry-after"));
          const seconds = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
          throw new AiProviderError(
            "ai_rate_limited",
            `The AI service is busy (rate limit reached).${seconds ? ` Try again in about ${seconds} seconds.` : " Try again in a minute."}`,
            seconds,
          );
        }
        if (res.status >= 500) {
          throw new AiProviderError("ai_unavailable", "The AI service had a problem. Try again in a moment.");
        }
        throw new AiProviderError("ai_bad_response", `The AI service refused the request (${res.status}).${detail ? ` ${detail}` : ""}`);
      }

      let payload: { choices?: { finish_reason?: string; message?: { content?: unknown } }[] };
      try {
        payload = (await res.json()) as typeof payload;
      } catch {
        throw new AiProviderError("ai_bad_response", "The AI service sent a reply that could not be read.");
      }
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new AiProviderError("ai_truncated", "The AI answer was cut off. Choose a smaller part of the source or fewer cards and try again.");
      }
      const content = choice?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new AiProviderError("ai_bad_response", "The AI service returned an empty answer.");
      }
      try {
        return JSON.parse(content);
      } catch {
        throw new AiProviderError("ai_bad_response", "The AI answer was not valid JSON.");
      }
    },
  };
}
