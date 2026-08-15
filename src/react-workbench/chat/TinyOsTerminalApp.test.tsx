// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TinyOsWindow } from "../../app-core/chat/tinyOsDesktopModel";
import { createTinyOsShellCommandRegistry, defineTinyOsShellCommand } from "../../app-core/chat/tinyOsShellCommandRegistry";
import { TinyOsTerminalApp } from "./TinyOsTerminalApp";

afterEach(cleanup);

const emptyTerminalWindow: TinyOsWindow = {
  appId: "terminal",
  entries: [],
  id: "window-terminal",
  sourceItemIds: [],
  title: "Terminal",
};

function terminalRegistry(dispatch = vi.fn()) {
  return createTinyOsShellCommandRegistry([
    defineTinyOsShellCommand({
      availability: { available: true },
      category: "process",
      dispatch,
      id: "terminal.execute",
      input: {
        fields: [
          { label: "command", name: "command", required: true },
          { label: "working directory", name: "cwd", required: false },
        ],
        kind: "fields",
      },
      keywords: ["terminal"],
      label: "Run Terminal command",
      scope: "runtime",
      target: { kind: "shell" },
    }),
    defineTinyOsShellCommand({
      availability: { available: false, reason: "No running process" },
      category: "process",
      dispatch: vi.fn(),
      id: "terminal.cancel",
      input: { kind: "none" },
      keywords: ["terminal"],
      label: "Cancel Terminal command",
      scope: "runtime",
      target: { kind: "shell" },
    }),
  ]);
}

function renderTerminal(commandRegistry = terminalRegistry()) {
  return render(<TinyOsTerminalApp
    canRequestChange={false}
    commandLifecycle={{ stage: "idle" }}
    commandRegistry={commandRegistry}
    onAgentRequest={vi.fn()}
    onAttachContext={vi.fn()}
    onTabChange={vi.fn()}
    window={emptyTerminalWindow}
  />);
}

describe("TinyOS terminal app", () => {
  it("owns the review boundary and dispatches the normalized command", async () => {
    const dispatch = vi.fn();
    const user = userEvent.setup();
    renderTerminal(terminalRegistry(dispatch));

    await user.type(screen.getByRole("textbox", { name: "TinyOS terminal command" }), "  npm test  ");
    await user.click(screen.getByRole("button", { name: "Review command" }));
    await user.click(screen.getByRole("button", { name: "Run command" }));

    expect(dispatch).toHaveBeenCalledWith({ kind: "shell" }, { command: "npm test", cwd: "." });
    expect(screen.getByText(/Run a reviewed command to create a retained canonical execution/)).toBeTruthy();
  });

  it("fails fast when the shell omits a required terminal command", () => {
    const registry = createTinyOsShellCommandRegistry([]);
    expect(() => renderTerminal(registry)).toThrow("Required TinyOS shell command is not registered: terminal.execute");
  });
});
