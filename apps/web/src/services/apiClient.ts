import { apiErrorSchema } from "@witlab/contracts";
import type { ZodType } from "zod";

/** Fired on window when the API says the browser is not signed in. */
export const UNAUTHORIZED_EVENT = "witlab:unauthorized";

/** Thrown for any failed API call, so UI code handles one error type. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** A readable message for anything thrown while calling the API. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "Something unexpected went wrong.";
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  body?: unknown;
  /** Raw bytes (for example a PDF) sent as-is instead of JSON. */
  raw?: { data: Blob; contentType: string };
  /** Non-2xx statuses that are a meaningful, parseable answer rather than an error (for example 503 from /health). */
  acceptStatuses?: number[];
}

/**
 * The only place the browser talks to the backend. Responses are validated against the shared contract schemas,
 * so a backend that drifts from the contract fails loudly here instead of corrupting the UI.
 * Pass `null` as the schema for endpoints that return no body (204).
 */
export async function request<T>(method: Method, path: string, schema: ZodType<T> | null, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  const apiBaseUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
  try {
    res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.raw
          ? { "Content-Type": options.raw.contentType }
          : options.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
      },
      body: options.raw ? options.raw.data : options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiRequestError("Could not reach the WitLab API. Is it running?", null, "network_error");
  }

  if (res.status === 204 && schema === null) return undefined as T;

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new ApiRequestError(`The API returned an unreadable response (HTTP ${res.status}).`, res.status, "bad_response");
  }

  if (res.ok || options.acceptStatuses?.includes(res.status)) {
    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiRequestError("The API response did not match the expected contract.", res.status, "contract_mismatch");
    }
    return parsed.data;
  }

  const apiError = apiErrorSchema.safeParse(payload);
  if (apiError.success) {
    // The session ended (expired, signed out elsewhere, account deleted): tell the app so it can show the sign-in page.
    if (res.status === 401 && apiError.data.error.code === "unauthorized") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiRequestError(apiError.data.error.message, res.status, apiError.data.error.code);
  }
  throw new ApiRequestError(`Request failed (HTTP ${res.status}).`, res.status, "http_error");
}
