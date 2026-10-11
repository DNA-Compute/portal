import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostedaiRequest } from "@/lib/hostedai/client";

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

const logged = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String).join("\n");
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const ok = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) });
/** What undici throws when the TCP connection to hosted.ai never opens. */
const connectTimeout = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });

beforeEach(() => {
  mockFetch.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("hosted.ai client logs", () => {
  it("redacts passwords, tokens and keys in logged requests and responses but returns them intact", async () => {
    const response = {
      id: "i-1",
      onboard_config: { username: "ubuntu", password: "s3cret-pass" },
      ssh_info: { cmd: "ssh ubuntu@host", pass: "ssh-pass-123" },
      access_token: "tok-abc",
    };
    mockFetch.mockResolvedValueOnce(ok(response));

    const result = await hostedaiRequest("POST", "/instances", { name: "box", root_password: "body-pass-9", api_key: "key-xyz" });

    expect(result).toEqual(response);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ name: "box", root_password: "body-pass-9", api_key: "key-xyz" });
    const text = logged();
    for (const secret of ["s3cret-pass", "ssh-pass-123", "tok-abc", "body-pass-9", "key-xyz"]) expect(text).not.toContain(secret);
    expect(text).toContain("ubuntu@host");
    expect(text).toContain("[redacted]");
  });

  it("redacts secrets in a logged error body", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, headers: new Headers(),
      text: async () => JSON.stringify({ message: "bad", echo: { password: "leaked-pass" } }) });

    await expect(hostedaiRequest("POST", "/instances", {})).rejects.toThrow("Hosted.ai API error (422): bad");
    expect(logged()).not.toContain("leaked-pass");
  });

  it("cuts a long non-JSON body short in the log and in the thrown error, since it cannot be redacted by key", async () => {
    const page = `<html>${"x".repeat(5_000)}</html>`;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, headers: new Headers(), text: async () => page });

    const failure = await hostedaiRequest("GET", "/instances").catch((error: Error) => error);

    expect((failure as Error).message.length).toBeLessThan(400);
    expect(logged().length).toBeLessThan(1_500);
  });
});

describe("hosted.ai client deadline", () => {
  it("also bounds reading the response body, not just the connection", async () => {
    mockFetch.mockImplementationOnce(async (_url: string, init: RequestInit) => ({
      ok: true, status: 200, headers: new Headers(),
      // A body that stalls until the request is aborted, as a hung upstream stream does.
      text: () => new Promise<string>((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }));

    const pending = hostedaiRequest("GET", "/instances", undefined, 2_000);
    const outcome = expect(pending).rejects.toThrow("TIMEOUT");
    await vi.advanceTimersByTimeAsync(2_000);
    await outcome;
  });
});

describe("hosted.ai client retries", () => {
  it("retries a request whose connection never opened, even a POST, since nothing reached hosted.ai", async () => {
    mockFetch.mockRejectedValueOnce(connectTimeout()).mockResolvedValueOnce(ok({ id: "i-1" }));

    const pending = hostedaiRequest("POST", "/instances", { name: "box" });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({ id: "i-1" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure after the connection opened, which may have run the request", async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));

    await expect(hostedaiRequest("POST", "/instances", { name: "box" })).rejects.toThrow("fetch failed");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up within the request's single deadline", async () => {
    mockFetch.mockRejectedValue(connectTimeout());

    const pending = hostedaiRequest("GET", "/instances", undefined, 2_000);
    const outcome = expect(pending).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await outcome;

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(3);
    // Every attempt shares the one abort signal, so the deadline bounds them all.
    const signals = new Set(mockFetch.mock.calls.map(call => call[1].signal));
    expect(signals.size).toBe(1);
  });

  it("does not follow redirects, so a retried request can only ever have failed on its first hop", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 307, headers: new Headers({ location: "https://elsewhere.example/api/instances" }), text: async () => "" });

    await expect(hostedaiRequest("POST", "/instances", {})).rejects.toThrow(/redirected .*elsewhere\.example.*HOSTEDAI_API_URL/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].redirect).toBe("manual");
  });
});
