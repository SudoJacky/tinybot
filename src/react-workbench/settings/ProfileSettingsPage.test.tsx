// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { SettingsStore } from "../services";
import { ProfileSettingsPage } from "./ProfileSettingsPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProfileSettingsPage", () => {
  test("renders charts and filters daily usage by provider and model", async () => {
    const observerCallbacks: IntersectionObserverCallback[] = [];
    const observerDisconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallbacks.push(callback);
      }

      disconnect() {
        observerDisconnect();
      }

      observe() {}

      takeRecords() {
        return [];
      }

      unobserve() {}
    });
    const settingsStore: SettingsStore = {
      load: vi.fn(async () => []),
      loadTokenUsage: vi.fn(async () => ({
        schemaVersion: "tinybot.token_usage.v2" as const,
        totals: usage(14_000, 8_000, 3_000, 1_200, 17_000),
        days: [
          { date: "2026-08-31", ...usage(12_000, 7_000, 3_000, 1_200, 15_000) },
          { date: "2026-08-30", ...usage(2_000, 1_000, 0, 0, 2_000) },
        ],
        modelDays: [
          {
            date: "2026-08-31",
            providerId: "openai",
            modelId: "gpt-5",
            ...usage(8_000, 5_000, 2_000, 800, 10_000),
          },
          {
            date: "2026-08-31",
            providerId: "anthropic",
            modelId: "claude-sonnet",
            ...usage(4_000, 2_000, 1_000, 400, 5_000),
          },
          {
            date: "2026-08-30",
            providerId: "openai",
            modelId: "gpt-5",
            ...usage(2_000, 1_000, 0, 0, 2_000),
          },
        ],
      })),
    };

    const { container } = render(<ProfileSettingsPage settingsStore={settingsStore} />);

    const summary = await screen.findByRole("region", { name: "Total tokens" });
    expect(within(summary).getByText("17,000")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Daily token usage peaked/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /openai \/ gpt-5 ranks first/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Token usage by provider and model" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Daily token usage" })).toBeTruthy();
    expect(container.querySelector(".react-profile-chart-card figcaption p")).toBeNull();
    expect(container.querySelector(".react-profile-chart-card__source")).toBeNull();
    expect(container.querySelector(".react-profile-usage-note")).toBeNull();

    const chartCards = [...container.querySelectorAll<HTMLElement>(".react-profile-chart-card")];
    expect(chartCards).toHaveLength(2);
    expect(chartCards.every((card) => card.dataset.revealState === "pending")).toBe(true);
    await waitFor(() => expect(observerCallbacks).toHaveLength(2));

    act(() => {
      for (const callback of observerCallbacks) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });

    expect(chartCards.every((card) => card.dataset.revealState === "revealed")).toBe(true);
    expect(observerDisconnect).toHaveBeenCalledTimes(2);

    const dailyChart = chartCards[0].querySelector("svg");
    fireEvent.click(chartCards[0]);
    expect(chartCards[0].querySelector("svg")).not.toBe(dailyChart);

    const modelChart = chartCards[1].querySelector("svg");
    fireEvent.keyDown(chartCards[1], { key: "Enter" });
    expect(chartCards[1].querySelector("svg")).not.toBe(modelChart);

    fireEvent.click(screen.getByRole("button", { name: /Filter token usage by provider/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "anthropic" }));

    expect(within(summary).getByText("5,000")).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "anthropic" })).toBeTruthy();
    expect(screen.queryByRole("rowheader", { name: "openai" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Filter token usage by model/ }));
    expect(screen.getByRole("menuitemradio", { name: "claude-sonnet" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Aug 31, 2026" })).toBeTruthy();
  });
});

function usage(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningOutputTokens: number,
  totalTokens: number,
) {
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}
