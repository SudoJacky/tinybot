import { describe, expect, test } from "vitest";

import { extractRetryAfterSeconds, withProviderRetry } from "./providerRetry";

describe("providerRetry", () => {
  test("retries transient failures in standard mode", async () => {
    let attempts = 0;
    const waits: number[] = [];

    const result = await withProviderRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("rate limit"), { status: 429 });
        }
        return "ok";
      },
      {
        retryMode: "standard",
        sleep: async (seconds) => {
          waits.push(seconds);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(waits).toEqual([1, 2]);
  });

  test("does not retry non-transient failures", async () => {
    let attempts = 0;

    await expect(
      withProviderRetry(
        async () => {
          attempts += 1;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
        { retryMode: "standard", sleep: async () => undefined },
      ),
    ).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });

  test("extracts retry-after from headers and provider body text", () => {
    expect(extractRetryAfterSeconds({ headers: { "retry-after": "7" } })).toBe(7);
    expect(extractRetryAfterSeconds({ response: { headers: { get: (name: string) => (name === "retry-after" ? "11" : null) } } })).toBe(11);
    expect(extractRetryAfterSeconds({ response: { text: "Please try again in 9 seconds." } })).toBe(9);
  });

  test("normalizes retry-after body units like the Python provider", () => {
    expect(extractRetryAfterSeconds({ response: { text: "retry after 1500 ms" } })).toBe(2);
    expect(extractRetryAfterSeconds({ response: { text: "wait 2 minutes before retry" } })).toBe(120);
    expect(extractRetryAfterSeconds({ response: { text: "{\"retry_after\": 3}" } })).toBe(3);
  });
});
