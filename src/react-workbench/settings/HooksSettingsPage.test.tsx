// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NativeCommandHookSnapshot } from "../../app-core/native/desktopNativeHooks";
import type { HooksStore, ProjectGroupStore, SessionStore } from "../services";
import { HooksSettingsPage } from "./HooksSettingsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "confirm");
});

const snapshot: NativeCommandHookSnapshot = {
  globalConfigPath: "C:\\Users\\demo\\.tinybot\\hooks.json",
  workspaceConfigPath: "D:\\work\\.tinybot\\hooks.json",
  trustStorePath: "C:\\Users\\demo\\.tinybot\\hook-trust.json",
  templateConfigPath: "C:\\Users\\demo\\.tinybot\\hooks.example.jsonc",
  templateScriptsPath: "C:\\Users\\demo\\.tinybot\\hook-templates",
  workspaceRoot: "D:\\work",
  diagnostics: [],
  hooks: [{
    hash: `sha256:${"a".repeat(64)}`,
    event: "PreToolUse",
    matcher: "^workspace\\.",
    command: "review-tool-input",
    timeout: 30,
    source: "workspace",
    sourcePath: "D:\\work\\.tinybot\\hooks.json",
    trusted: false,
    enabled: true,
  }],
};

const sessionStore: SessionStore = {
  list: vi.fn(async () => [{
    id: "thread-1",
    title: "Workspace chat",
    updatedAtMs: 2,
    workingDirectory: "D:\\work",
  }]),
  create: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  pin: vi.fn(),
  archive: vi.fn(),
};

const projectGroupStore: ProjectGroupStore = {
  list: vi.fn(async () => [{ projectGroupId: "group-1", name: "Project", workspaceIds: ["D:\\project"] }]),
  save: vi.fn(),
  delete: vi.fn(),
};

describe("HooksSettingsPage", () => {
  test("requires confirmation before trusting an exact command definition", async () => {
    const user = userEvent.setup();
    const hooksStore: HooksStore = {
      load: vi.fn(async () => snapshot),
      setTrusted: vi.fn(async () => ({
        ...snapshot,
        hooks: snapshot.hooks.map((hook) => ({ ...hook, trusted: true })),
      })),
      saveManaged: vi.fn(async () => snapshot),
    };
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });

    render(
      <HooksSettingsPage
        hooksStore={hooksStore}
        projectGroupStore={projectGroupStore}
        sessionStore={sessionStore}
      />,
    );
    expect(await screen.findByText(snapshot.templateConfigPath)).toBeTruthy();
    expect(screen.getByText(snapshot.templateScriptsPath)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Trust definition" }));

    await waitFor(() => expect(hooksStore.setTrusted).toHaveBeenCalledWith({
      workspacePath: "D:\\work",
      hash: snapshot.hooks[0].hash,
      trusted: true,
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("review-tool-input"));
    expect(await screen.findByText("Trusted")).toBeTruthy();
  });

  test("creates a managed hook in a workspace already configured by Chat", async () => {
    const user = userEvent.setup();
    const hooksStore: HooksStore = {
      load: vi.fn(async () => ({ ...snapshot, hooks: [] })),
      setTrusted: vi.fn(async () => snapshot),
      saveManaged: vi.fn(async () => snapshot),
    };

    render(
      <HooksSettingsPage
        hooksStore={hooksStore}
        projectGroupStore={projectGroupStore}
        sessionStore={sessionStore}
      />,
    );
    await screen.findByRole("option", { name: "work — D:\\work" });
    expect(screen.getByRole("option", { name: "project — D:\\project" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New hook" }));
    await user.type(screen.getByRole("textbox", { name: "Hook name" }), "Protect files");
    await user.click(screen.getByRole("button", { name: "Create script" }));

    await waitFor(() => expect(hooksStore.saveManaged).toHaveBeenCalledWith({
      workspacePath: "D:\\work",
      name: "Protect files",
      event: "PreToolUse",
      matcher: "*",
      language: expect.stringMatching(/^(powershell|shell)$/),
      enabled: true,
      timeout: 30,
    }));
  });
});
