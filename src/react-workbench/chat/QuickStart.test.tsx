// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProviderModelsSettings } from "../../app-core/settings/providerModelsSettings";
import type { SettingsStore } from "../services";
import { QuickStart, QuickStartModelDialog } from "./QuickStart";
import { QUICK_START_STORAGE_KEY, useQuickStart } from "./useQuickStart";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function store(models = false): SettingsStore {
  let config: Record<string, unknown> = {};
  return {
    load: async () => [],
    loadChatModels: vi.fn(async () => models ? [{ id: "model-1", label: "Model 1", providerId: "deepseek" }] : []),
    loadProviderSettings: vi.fn(async () => buildProviderModelsSettings(config)),
    saveProviderSettings: vi.fn(async (_current, patch) => {
      // The production persistence merges profile patches into the current snapshot.
      const next = patch as { providers: { profiles: Record<string, Record<string, unknown>> } };
      const previous = config.providers as { profiles: Record<string, Record<string, unknown>> } | undefined;
      const profiles = { ...previous?.profiles };
      for (const [id, profile] of Object.entries(next.providers.profiles)) profiles[id] = { ...profiles[id], ...profile };
      config = { ...config, ...next, providers: { profiles } };
      return buildProviderModelsSettings(config);
    }),
    saveDefaultChatModel: vi.fn(async () => undefined),
    fetchProviderModels: vi.fn(async () => ({ ok: true, models: ["model-1"] })),
  };
}

describe("quick start progress", () => {
  it("starts only for users without usable models, remembers dismissal, and allows reopening", async () => {
    const settings = store();
    const first = renderHook(() => useQuickStart(settings));
    await waitFor(() => expect(first.result.current.visible).toBe(true));
    act(() => first.result.current.dismiss());
    first.unmount();
    const next = renderHook(() => useQuickStart(settings));
    await waitFor(() => expect(next.result.current.loaded).toBe(true));
    expect(next.result.current.visible).toBe(false);
    act(() => next.result.current.open());
    expect(next.result.current.visible).toBe(true);
  });

  it("leaves existing users alone and records completion only after a task", async () => {
    const settings = store(true);
    const { result } = renderHook(() => useQuickStart(settings));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.visible).toBe(false);
    expect(localStorage.getItem(QUICK_START_STORAGE_KEY)).toBeNull();
    act(() => result.current.open());
    act(() => result.current.completeTask());
    expect(result.current.visible).toBe(true);
    act(() => result.current.beginTask());
    expect(localStorage.getItem(QUICK_START_STORAGE_KEY)).toBe("started");
    act(() => result.current.completeTask());
    expect(localStorage.getItem(QUICK_START_STORAGE_KEY)).toBe("completed");
    expect(result.current.visible).toBe(false);
  });

  it("does not interpret a failed load as an unconfigured account, and supports retry", async () => {
    const settings = store();
    vi.mocked(settings.loadChatModels!).mockRejectedValueOnce(new Error("Offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useQuickStart(settings));
    await waitFor(() => expect(result.current.error).toBe("Offline"));
    expect(result.current.visible).toBe(false);
    expect(localStorage.getItem(QUICK_START_STORAGE_KEY)).toBeNull();
    act(() => result.current.reloadModels());
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.error).toBe("");
    log.mockRestore();
  });
});

describe("quick start interactions", () => {
  it("keeps model discovery errors visible and saves the selected model through settings", async () => {
    const settings = store();
    const configured = vi.fn();
    vi.mocked(settings.fetchProviderModels!).mockResolvedValueOnce({ ok: false, models: [], error: "Unauthorized" });
    render(<QuickStartModelDialog settingsStore={settings} onClose={vi.fn()} onConfigured={configured} />);
    fireEvent.change(await screen.findByLabelText("API key"), { target: { value: "secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & fetch models" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unauthorized");
    expect(configured).not.toHaveBeenCalled();
    expect(settings.saveDefaultChatModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save & fetch models" }));
    await screen.findByText("Model list retrieved. Select a model or enter its ID.");
    expect((screen.getByLabelText("Model ID") as HTMLInputElement).value).toBe("model-1");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    fireEvent.submit(screen.getByRole("button", { name: "Save & continue" }).closest("form")!);
    await waitFor(() => expect(configured).toHaveBeenCalledOnce());
    expect(settings.saveDefaultChatModel).toHaveBeenCalledWith({ modelId: "model-1", providerId: "deepseek" });
    const saved = await settings.loadProviderSettings!();
    expect(saved.providers.find((item) => item.id === "deepseek")?.models.find((item) => item.id === "model-1")?.enabled).toBe(true);
  });

  it("does not fetch static catalogs or require credentials for local providers", async () => {
    render(<QuickStartModelDialog settingsStore={store()} onClose={vi.fn()} onConfigured={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Provider"), { target: { value: "zai-default" } });
    expect(screen.queryByRole("button", { name: "Save & fetch models" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama-default" } });
    expect((screen.getByLabelText("API key") as HTMLInputElement).required).toBe(false);
  });

  it("only fills examples, and cancels a project example when the folder picker is cancelled", async () => {
    const onExample = vi.fn();
    const onAddWorkspace = vi.fn(async () => undefined);
    render(<QuickStart ready settingsStore={store(true)} onConfigured={vi.fn()} onDismiss={vi.fn()} onExample={onExample} onAddWorkspace={onAddWorkspace} workspaceEnabled pending={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask a question" }));
    expect(onExample).toHaveBeenCalledWith(expect.stringContaining("three specific examples"));
    onExample.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Understand a project" }));
    await waitFor(() => expect(onAddWorkspace).toHaveBeenCalledOnce());
    expect(onExample).not.toHaveBeenCalled();
  });
});
