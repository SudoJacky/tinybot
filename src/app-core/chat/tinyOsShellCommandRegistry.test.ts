import { describe, expect, it, vi } from "vitest";

import {
  createTinyOsShellCommandRegistry,
  defineTinyOsShellCommand,
  executeTinyOsShellCommand,
} from "./tinyOsShellCommandRegistry";

describe("TinyOS shell command registry", () => {
  it("registers and executes typed local presentation commands", async () => {
    const dispatch = vi.fn();
    const command = defineTinyOsShellCommand({
      availability: { available: true },
      category: "application",
      dispatch,
      id: "app.open:terminal",
      input: { kind: "none" },
      keywords: ["Terminal", " terminal ", "shell"],
      label: "Open Terminal",
      scope: "local_presentation",
      target: { appId: "terminal", kind: "application" },
    });
    const registry = createTinyOsShellCommandRegistry([command]);

    await expect(registry.execute(command.id)).resolves.toEqual({ commandId: command.id, status: "executed" });
    expect(dispatch).toHaveBeenCalledWith({ appId: "terminal", kind: "application" }, undefined);
    expect(registry.get(command.id)?.keywords).toEqual(["terminal", "shell"]);
  });

  it("rejects unavailable runtime commands without dispatch", async () => {
    const dispatch = vi.fn();
    const command = defineTinyOsShellCommand({
      availability: { available: false, reason: "History snapshots are read-only.", reasonCode: "history_read_only" },
      category: "process",
      dispatch,
      id: "agent.cancel",
      input: { kind: "none" },
      keywords: ["cancel", "stop"],
      label: "Cancel Agent run",
      scope: "runtime",
      target: { kind: "run", runId: "run-1" },
    });

    await expect(executeTinyOsShellCommand(command)).resolves.toEqual({
      commandId: "agent.cancel",
      reason: "History snapshots are read-only.",
      reasonCode: "history_read_only",
      status: "rejected",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("enforces History read-only at the registry boundary while keeping local commands available", async () => {
    const runtimeDispatch = vi.fn();
    const localDispatch = vi.fn();
    const registry = createTinyOsShellCommandRegistry([
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "process",
        dispatch: runtimeDispatch,
        id: "terminal.execute",
        input: { kind: "none" },
        keywords: ["terminal"],
        label: "Run command",
        scope: "runtime",
        target: { kind: "shell" },
      }),
      defineTinyOsShellCommand({
        availability: { available: true },
        category: "window",
        dispatch: localDispatch,
        id: "window.focus:terminal",
        input: { kind: "none" },
        keywords: ["terminal"],
        label: "Focus Terminal",
        scope: "local_presentation",
        target: { appId: "terminal", kind: "window" },
      }),
    ], { simulationMode: "history" });

    await expect(registry.execute("terminal.execute")).resolves.toMatchObject({
      reasonCode: "history_read_only",
      status: "rejected",
    });
    await expect(registry.execute("window.focus:terminal")).resolves.toMatchObject({ status: "executed" });
    expect(registry.get("terminal.execute")?.availability).toMatchObject({
      available: false,
      reason: "History snapshots are read-only.",
    });
    expect(runtimeDispatch).not.toHaveBeenCalled();
    expect(localDispatch).toHaveBeenCalledTimes(1);
  });

  it("fails fast for invalid or ambiguous registrations", () => {
    const dispatch = vi.fn();
    expect(() => defineTinyOsShellCommand({
      availability: { available: false, reason: "" },
      category: "system",
      dispatch,
      id: "shell.overview",
      input: { kind: "none" },
      keywords: [],
      label: "Overview",
      scope: "local_presentation",
      target: { kind: "shell" },
    })).toThrow("unavailable without a reason");

    const command = defineTinyOsShellCommand({
      availability: { available: true },
      category: "system",
      dispatch,
      id: "shell.overview",
      input: { kind: "none" },
      keywords: [],
      label: "Overview",
      scope: "local_presentation",
      target: { kind: "shell" },
    });
    expect(() => createTinyOsShellCommandRegistry([command, command])).toThrow("Duplicate TinyOS shell command id");
  });

  it("does not swallow dispatcher failures", async () => {
    const command = defineTinyOsShellCommand({
      availability: { available: true },
      category: "process",
      dispatch: () => { throw new Error("gateway dispatch failed"); },
      id: "agent.pause",
      input: { kind: "none" },
      keywords: [],
      label: "Pause Agent run",
      scope: "runtime",
      target: { kind: "run", runId: "run-1" },
    });

    await expect(executeTinyOsShellCommand(command)).rejects.toThrow("gateway dispatch failed");
  });

  it("validates structured runtime command input before dispatch", async () => {
    const dispatch = vi.fn();
    const command = defineTinyOsShellCommand({
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
    });
    const registry = createTinyOsShellCommandRegistry([command]);

    await expect(registry.execute("terminal.execute")).rejects.toThrow("requires structured input");
    await expect(registry.execute("terminal.execute", { command: "  " })).rejects.toThrow("requires command");
    await expect(registry.execute("terminal.execute", { command: "cargo test", cwd: "." })).resolves.toEqual({
      commandId: "terminal.execute",
      status: "executed",
    });
    expect(dispatch).toHaveBeenCalledWith({ kind: "shell" }, { command: "cargo test", cwd: "." });
  });
});
