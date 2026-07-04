import { describe, expect, it } from "vitest";
import { formatRelativeUpdatedTime } from "./relativeTime";

describe("formatRelativeUpdatedTime", () => {
  const now = Date.UTC(2026, 6, 4, 12, 0, 0);

  it("formats recent timestamps without exposing raw unix-ms values", () => {
    expect(formatRelativeUpdatedTime(now - 4 * 60_000, now)).toBe("4 min");
    expect(formatRelativeUpdatedTime(`unix-ms:${now - 2 * 60 * 60_000}`, now)).toBe("2 hr");
  });

  it("uses day, week, and month buckets for older sessions", () => {
    expect(formatRelativeUpdatedTime(now - 3 * 24 * 60 * 60_000, now)).toBe("3 days");
    expect(formatRelativeUpdatedTime(now - 14 * 24 * 60 * 60_000, now)).toBe("2 wk");
    expect(formatRelativeUpdatedTime(now - 70 * 24 * 60 * 60_000, now)).toBe("2 mo");
  });

  it("falls back to a quiet placeholder for missing or invalid timestamps", () => {
    expect(formatRelativeUpdatedTime("", now)).toBe("No date");
    expect(formatRelativeUpdatedTime("not-a-date", now)).toBe("No date");
  });
});
