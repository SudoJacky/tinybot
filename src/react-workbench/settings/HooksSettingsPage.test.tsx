// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { NativeCommandHookSnapshot } from "../../app-core/native/desktopNativeHooks";
import type { HooksStore } from "../services";
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
  }],
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
    };
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });

    render(<HooksSettingsPage hooksStore={hooksStore} />);
    expect(await screen.findByText(snapshot.templateConfigPath)).toBeTruthy();
    expect(screen.getByText(snapshot.templateScriptsPath)).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Trust definition" }));

    await waitFor(() => expect(hooksStore.setTrusted).toHaveBeenCalledWith({
      hash: snapshot.hooks[0].hash,
      trusted: true,
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("review-tool-input"));
    expect(await screen.findByText("Trusted")).toBeTruthy();
  });
});
