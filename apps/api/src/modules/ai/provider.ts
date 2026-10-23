/**
 * The only thing the rest of the app knows about AI. Swapping provider means writing another adapter
 * (or just changing configuration for any OpenAI-compatible service); nothing else changes.
 * The API key lives inside the adapter and is never sent to the browser or written to logs or errors.
 */

export interface StructuredRequest {
  system: string;
  user: string;
  /** Name of the JSON schema, for providers that ask for one. */
  schemaName: string;
  /** JSON Schema describing the object the model must return. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface AiProvider {
  /** Identifier recorded on each generation job. */
  readonly model: string;
  /** Returns the parsed JSON object the model produced. Throws AiProviderError on any failure. */
  generateStructured(request: StructuredRequest): Promise<unknown>;
}

export type AiErrorCode =
  | "ai_rate_limited"
  | "ai_auth"
  | "ai_unavailable"
  | "ai_timeout"
  | "ai_bad_response"
  | "ai_truncated";

export class AiProviderError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

/** HTTP status used when an AI failure is reported to the client. */
export function aiHttpStatus(code: AiErrorCode): number {
  switch (code) {
    case "ai_rate_limited":
      return 429;
    case "ai_timeout":
      return 504;
    default:
      return 502;
  }
}
