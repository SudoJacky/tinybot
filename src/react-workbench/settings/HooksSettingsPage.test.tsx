// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      testManaged: vi.fn(async () => ({
        id: "protect-files",
        event: "PreToolUse" as const,
        decision: "continue",
        durationMs: 2,
      })),
      archiveManaged: vi.fn(async () => snapshot),
      readManagedScript: vi.fn(async () => ({
        id: "protect-files",
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: "# script\n",
        revision: "sha256:before",
      })),
      saveManagedScript: vi.fn(async (input) => ({
        id: input.id,
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: input.contents,
        revision: "sha256:after",
      })),
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
      testManaged: vi.fn(async () => ({
        id: "protect-files",
        event: "PreToolUse" as const,
        decision: "continue",
        durationMs: 2,
      })),
      archiveManaged: vi.fn(async () => snapshot),
      readManagedScript: vi.fn(async () => ({
        id: "protect-files",
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: "# script\n",
        revision: "sha256:before",
      })),
      saveManagedScript: vi.fn(async (input) => ({
        id: input.id,
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: input.contents,
        revision: "sha256:after",
      })),
    };

    render(
      <HooksSettingsPage
        hooksStore={hooksStore}
        projectGroupStore={projectGroupStore}
        sessionStore={sessionStore}
      />,
    );
    await user.click(await screen.findByRole("button", { name: /Workspace directory: work/ }));
    expect(screen.getByRole("menuitemradio", { name: /project.*D:\\project/ })).toBeTruthy();
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

  test("tests trusted scripts and archives removed managed hooks", async () => {
    const user = userEvent.setup();
    const managedSnapshot: NativeCommandHookSnapshot = {
      ...snapshot,
      hooks: [{
        ...snapshot.hooks[0],
        trusted: true,
        managed: {
          id: "protect-files",
          name: "Protect files",
          language: "powershell",
          manifestPath: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.json",
          scriptPath: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        },
      }],
    };
    const hooksStore: HooksStore = {
      load: vi.fn(async () => managedSnapshot),
      setTrusted: vi.fn(async () => managedSnapshot),
      saveManaged: vi.fn(async () => managedSnapshot),
      testManaged: vi.fn(async () => ({
        id: "protect-files",
        event: "PreToolUse" as const,
        decision: "continue",
        durationMs: 2,
      })),
      archiveManaged: vi.fn(async () => ({ ...managedSnapshot, hooks: [] })),
      readManagedScript: vi.fn(async () => ({
        id: "protect-files",
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: "# original\n",
        revision: "sha256:before",
      })),
      saveManagedScript: vi.fn(async (input) => ({
        id: input.id,
        name: "Protect files",
        language: "powershell" as const,
        path: "D:\\work\\.tinybot\\hooks\\protect-files\\hook.ps1",
        contents: input.contents,
        revision: "sha256:after",
      })),
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
    await user.click(await screen.findByRole("button", { name: "Edit script" }));
    const scriptEditor = await screen.findByRole("textbox", { name: "Script contents" });
    expect((scriptEditor as HTMLTextAreaElement).value).toBe("# original\n");
    (scriptEditor as HTMLTextAreaElement).setSelectionRange(0, 10);
    fireEvent.keyDown(scriptEditor, { code: "Slash", ctrlKey: true, key: "/" });
    await waitFor(() => expect((scriptEditor as HTMLTextAreaElement).value).toBe("original\n"));
    (scriptEditor as HTMLTextAreaElement).setSelectionRange(0, 8);
    await user.click(screen.getByRole("button", { name: /Toggle comment/ }));
    await waitFor(() => expect((scriptEditor as HTMLTextAreaElement).value).toBe("# original\n"));
    await user.clear(scriptEditor);
    await user.type(scriptEditor, "# edited");
    fireEvent.keyDown(scriptEditor, { ctrlKey: true, key: "s" });
    await waitFor(() => expect(hooksStore.saveManagedScript).toHaveBeenCalledWith({
      workspacePath: "D:\\work",
      id: "protect-files",
      contents: "# edited",
      expectedRevision: "sha256:before",
    }));
    expect(await screen.findByText("Script saved")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Test" }));
    expect(await screen.findByText("Test decision: continue")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(hooksStore.archiveManaged).toHaveBeenCalledWith({
      workspacePath: "D:\\work",
      id: "protect-files",
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("hooks-archive"));
  });
});
