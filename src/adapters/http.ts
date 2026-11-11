import { AdapterError } from "./types";

export const TIMEOUT_MS = 15_000;
export const MODEL_TIMEOUT_MS = 25_000;

// Never put headers, bodies or tokens into the error message
export async function send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new AdapterError("timeout", "provider timed out");
    throw new AdapterError("unavailable", "provider unreachable");
  }
}

export function failFor(status: number, what: string): AdapterError {
  const kind = status >= 400 && status < 500 && status !== 429 ? "rejected" : "unavailable";
  return new AdapterError(kind, `${what} failed with status ${status}`);
}

export async function jsonOf(r: Response, what: string): Promise<unknown> {
  try {
    return await r.json();
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new AdapterError("timeout", `${what} timed out`);
    throw new AdapterError("unavailable", `${what} returned invalid JSON`);
  }
}
