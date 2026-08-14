// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PersonalizationInstructionsSaveInput, SettingsStore } from "../services";
import { PersonalizationSettingsPage } from "./PersonalizationSettingsPage";

afterEach(() => cleanup());

function createSettingsStore(): SettingsStore {
  return {
    load: vi.fn(async () => []),
    loadPersonalizationInstructions: vi.fn(async () => ({
      path: "USER.md" as const,
      contents: "Prefer concise answers.",
      updatedAt: "unix-ms:100",
    })),
    savePersonalizationInstructions: vi.fn(async (input: PersonalizationInstructionsSaveInput) => ({
      path: "USER.md" as const,
      contents: input.contents,
      updatedAt: "unix-ms:200",
    })),
  };
}

describe("PersonalizationSettingsPage", () => {
  test("edits USER.md and saves against the loaded revision", async () => {
    const user = userEvent.setup();
    const settingsStore = createSettingsStore();
    render(<PersonalizationSettingsPage settingsStore={settingsStore} />);

    const editor = await screen.findByRole("textbox", { name: "Custom instructions" });
    await user.clear(editor);
    await user.type(editor, "Prefer concrete answers.");
    await user.click(screen.getByRole("button", { name: "Save custom instructions" }));

    await waitFor(() => expect(settingsStore.savePersonalizationInstructions).toHaveBeenCalledWith({
      contents: "Prefer concrete answers.",
      expectedUpdatedAt: "unix-ms:100",
    }));
    expect(await screen.findByText("Custom instructions saved.")).toBeTruthy();
  });

  test("keeps the draft visible when a revision conflict prevents saving", async () => {
    const user = userEvent.setup();
    const settingsStore = createSettingsStore();
    settingsStore.savePersonalizationInstructions = vi.fn(async () => {
      throw new Error("workspace revision conflict");
    });
    render(<PersonalizationSettingsPage settingsStore={settingsStore} />);

    const editor = await screen.findByRole("textbox", { name: "Custom instructions" });
    await user.clear(editor);
    await user.type(editor, "Do not overwrite this draft.");
    await user.click(screen.getByRole("button", { name: "Save custom instructions" }));

    expect((await screen.findByRole("alert")).textContent).toContain("workspace revision conflict");
    expect((editor as HTMLTextAreaElement).value).toBe("Do not overwrite this draft.");
  });
});
