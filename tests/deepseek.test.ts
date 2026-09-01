import { afterEach, describe, expect, it, vi } from "vitest";

import { callDeepseekJson } from "../netlify/functions/_shared/deepseek";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DeepSeek JSON requests", () => {
  it("explicitly disables thinking for the standard Flash analysis", async () => {
    let thinking: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      thinking = requestBody.thinking;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await callDeepseekJson("sk-test-only", "deepseek-v4-flash", "返回 JSON", {}, 1800);

    expect(thinking).toEqual({ type: "disabled" });
  });

  it("keeps Pro deep analysis in non-thinking mode so it can finish inside the function budget", async () => {
    let thinking: unknown;
    globalThis.fetch = vi.fn(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      thinking = requestBody.thinking;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "{\"overview\":\"ok\"}" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    await callDeepseekJson("sk-test-only", "deepseek-v4-pro", "返回 JSON", {}, 3500);

    expect(thinking).toEqual({ type: "disabled" });
  });

  it("aborts a slow Pro response before the 30-second local function limit", async () => {
    vi.useFakeTimers();
    let settled = false;
    globalThis.fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as typeof fetch;

    void callDeepseekJson("sk-test-only", "deepseek-v4-pro", "返回 JSON", {}, 3500)
      .catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_000);

    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
