/**
 * Base API client for hosted.ai
 *
 * Provides low-level HTTP client and caching utilities.
 * Most consumers should use the higher-level functions from
 * teams.ts, pools.ts, billing.ts, etc. instead.
 *
 * @internal This module exports are primarily for internal use
 * @module hostedai/client
 */

import { getSetting } from "@/lib/settings";

// In-memory cache for API responses (10 second TTL)
const apiCache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL_MS = 120 * 1000; // 2 minutes — shared across cron jobs to reduce hosted.ai API load

/**
 * Get cached API response
 * @internal
 */
export function getCached<T>(key: string): T | null {
  const cached = apiCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`[Hosted.AI] Cache hit for ${key}`);
    return cached.data as T;
  }
  return null;
}

/**
 * Store data in the API cache
 * @internal
 */
export function setCache(key: string, data: unknown): void {
  apiCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Clear cached API responses
 * @param keyPattern - Optional pattern to match keys to clear
 */
export function clearCache(keyPattern?: string): void {
  if (keyPattern) {
    for (const key of apiCache.keys()) {
      if (key.includes(keyPattern)) {
        apiCache.delete(key);
      }
    }
  } else {
    apiCache.clear();
  }
}

// "url" covers one-time login links, which sign whoever opens them in to the console.
const SECRET_KEY = /pass|secret|token|api_?key|private|credential|^url$/i;

/** A copy of an API payload that is safe to log: values under secret-looking keys are replaced. */
function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redactForLog(v)])
    );
  }
  return value;
}

const logJson = (value: unknown) => JSON.stringify(redactForLog(value), null, 2);

/** Non-JSON text cannot be redacted by key, and is usually an HTML error page, so only its start is kept. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text);

/** A response body for the log: redacted when it is JSON, clipped otherwise. */
function logBody(text: string): string {
  try {
    return logJson(JSON.parse(text));
  } catch {
    return clip(text, 500);
  }
}

/**
 * Failures where the TCP connection never opened, so hosted.ai cannot have seen the request
 * and retrying it, even a POST, cannot run it twice. Redirects are not followed (see below),
 * so the failed connection is always the first and only hop.
 */
const NEVER_CONNECTED = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED"]);
const RETRY_DELAYS_MS = [250, 1_000];

/**
 * When hosted.ai stops answering connections, every page and job would otherwise wait out the
 * connect timeout and its retries on every call: on prod in 2026-10 that was hundreds of attempts
 * an hour, 40-second admin pages, and a firewall ban that kept renewing itself. After
 * PAUSE_AFTER_FAILURES requests in a row that could not connect, calls fail at once for a pause;
 * then one call is let through to test the connection, and the pause doubles (up to
 * MAX_PAUSE_MS) while that test call keeps failing. Any answer from hosted.ai, even an error
 * status, ends the pause. Per process, which is fine for the one portal server.
 */
const PAUSE_AFTER_FAILURES = 3;
const FIRST_PAUSE_MS = 60_000;
const MAX_PAUSE_MS = 10 * 60_000;
const connection = { failures: 0, pausedUntil: 0, pauseMs: FIRST_PAUSE_MS };

/** Clears the pause. @internal For tests. */
export function resetConnectionPause(): void {
  Object.assign(connection, { failures: 0, pausedUntil: 0, pauseMs: FIRST_PAUSE_MS });
}

/** Throws while calls are paused; otherwise lets the call through (and claims the test call when a pause ends). */
function checkConnectionPause(method: string, endpoint: string): void {
  if (connection.failures < PAUSE_AFTER_FAILURES) return;
  const now = Date.now();
  if (now < connection.pausedUntil) {
    throw Object.assign(
      new Error(`hosted.ai cannot be reached; not calling ${method} ${endpoint} until ${new Date(connection.pausedUntil).toISOString()}`),
      { cause: { code: "HOSTEDAI_PAUSED" } },
    );
  }
  // This call tests the connection; others keep failing at once until it is answered.
  connection.pausedUntil = now + connection.pauseMs;
}

function connectionWorked(): void {
  if (connection.failures >= PAUSE_AFTER_FAILURES) console.log("[Hosted.AI] Connection is back; calls resume");
  resetConnectionPause();
}

function connectionFailed(code: string): void {
  connection.failures++;
  if (connection.failures < PAUSE_AFTER_FAILURES) return;
  if (connection.failures > PAUSE_AFTER_FAILURES) connection.pauseMs = Math.min(connection.pauseMs * 2, MAX_PAUSE_MS);
  connection.pausedUntil = Date.now() + connection.pauseMs;
  console.error(`[Hosted.AI] Cannot connect (${code}) ${connection.failures} times in a row; pausing calls for ${connection.pauseMs / 1000}s`);
}

function connectFailureCode(error: unknown): string | undefined {
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  return typeof code === "string" && NEVER_CONNECTED.has(code) ? code : undefined;
}

/**
 * Make an authenticated request to the hosted.ai API
 * @internal Use higher-level functions from teams.ts, pools.ts, etc.
 * @param timeoutMs - Optional deadline in milliseconds for the request and any retries
 *   (default: 15s for GET, 30s for POST)
 */
export async function hostedaiRequest<T>(
  method: string,
  endpoint: string,
  data?: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  checkConnectionPause(method, endpoint);
  const [apiUrl, apiKey] = await Promise.all([getApiUrl(), getApiKey()]);
  const url = `${apiUrl}/api${endpoint}`;

  // Default timeout: 15s for GET, 30s for POST (prevents indefinite hangs)
  const effectiveTimeout = timeoutMs ?? (method === "GET" ? 15_000 : 30_000);

  console.log(`[Hosted.AI] ${method} ${url} (timeout: ${effectiveTimeout}ms)`);
  if (data) {
    console.log(`[Hosted.AI] Request body:`, logJson(data));
  }

  // One deadline covers every attempt: all of them share this abort signal.
  const controller = new AbortController();
  const deadline = Date.now() + effectiveTimeout;
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, effectiveTimeout);

  // Set when an attempt could not connect; if the request then ends with no answer at all (the
  // retries also fail, or the deadline cuts one short), it counts towards pausing calls.
  let failedToConnect: string | undefined;
  let answered = false;
  try {
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(url, {
          method,
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: data ? JSON.stringify(data) : undefined,
          // A followed redirect could fail to connect after the first host already ran
          // the request, which would make the retry below unsafe.
          redirect: "manual",
          signal: controller.signal,
        });
        answered = true;
        connectionWorked();
        break;
      } catch (error) {
        const code = connectFailureCode(error);
        const delay = RETRY_DELAYS_MS[attempt];
        if (code) failedToConnect = code;
        if (!code || delay === undefined || Date.now() + delay >= deadline) throw error;
        console.warn(`[Hosted.AI] Could not connect for ${method} ${endpoint} (${code}); retrying in ${delay}ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "an unknown address";
      throw new Error(
        `Hosted.ai API redirected ${method} ${endpoint} to ${location}; set HOSTEDAI_API_URL to the address it redirects to`
      );
    }

    // Always read the response body, still under the deadline: a stalled stream must not hang the caller.
    const text = await response.text();

    if (!response.ok) {
      console.error(`[Hosted.AI] API error ${response.status}:`, logBody(text));

      // Try to parse error as JSON for better error messages
      let errorMessage = clip(text, 200);
      try {
        const errorData = JSON.parse(text);
        errorMessage = errorData.message || errorData.error || clip(text, 200);
        if (errorData.errors && Array.isArray(errorData.errors)) {
          const fieldErrors = errorData.errors.map((e: { field?: string; message?: string }) =>
            `${e.field}: ${e.message}`
          ).join(", ");
          errorMessage = `${errorMessage} (${fieldErrors})`;
        }
      } catch {
        // Text is not JSON, use as-is
      }

      throw new Error(`Hosted.ai API error (${response.status}): ${errorMessage}`);
    }

    // Handle empty responses (some endpoints return 200 with no body)
    if (!text) {
      console.log(`[Hosted.AI] Empty response for: ${endpoint}`);
      return {} as T;
    }

    try {
      const parsed = JSON.parse(text);
      console.log(`[Hosted.AI] Response:`, logJson(parsed));
      return parsed;
    } catch {
      console.log(`[Hosted.AI] Non-JSON response:`, logBody(text));
      return { success: true } as T;
    }
  } catch (error) {
    if (failedToConnect && !answered) connectionFailed(failedToConnect);
    // Handle abort/timeout
    if (error instanceof Error && error.name === 'AbortError') {
      console.log(`[Hosted.AI] Request timed out after ${effectiveTimeout}ms: ${endpoint}`);
      throw new Error(`TIMEOUT: Request to ${endpoint} timed out after ${effectiveTimeout}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get the hosted.ai API base URL (DB-backed platform settings, env fallback)
 * @internal
 */
export async function getApiUrl(): Promise<string> {
  const url = await getSetting("HOSTEDAI_API_URL");
  if (!url) throw new Error("HOSTEDAI_API_URL is not set — configure in Platform Settings or .env.local");
  return url;
}

/**
 * Get the hosted.ai API key (DB-backed platform settings, env fallback)
 * @internal
 */
export async function getApiKey(): Promise<string> {
  const key = await getSetting("HOSTEDAI_API_KEY");
  if (!key) throw new Error("HOSTEDAI_API_KEY is not set — configure in Platform Settings or .env.local");
  return key;
}
