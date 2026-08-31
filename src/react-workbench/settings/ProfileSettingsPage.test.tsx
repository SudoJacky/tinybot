// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SettingsStore } from "../services";
import { ProfileSettingsPage } from "./ProfileSettingsPage";

afterEach(() => cleanup());

describe("ProfileSettingsPage", () => {
  test("renders all-time totals and daily token categories", async () => {
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadTokenUsage: vi.fn(async () => ({
        schemaVersion: "tinybot.token_usage.v1" as const,
        totals: {
          inputTokens: 12_000,
          cachedInputTokens: 8_000,
          outputTokens: 3_000,
          reasoningOutputTokens: 1_200,
          totalTokens: 15_000,
        },
        days: [{
          date: "2026-08-31",
          inputTokens: 12_000,
          cachedInputTokens: 8_000,
          outputTokens: 3_000,
          reasoningOutputTokens: 1_200,
          totalTokens: 15_000,
        }],
      })),
    };

    render(<ProfileSettingsPage settingsStore={settingsStore} />);

    expect(await screen.findAllByText("15,000")).toHaveLength(2);
    expect(screen.getByRole("table", { name: "Daily token usage" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Cached input" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Reasoning output" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Aug 31, 2026" })).toBeTruthy();
  });
});
