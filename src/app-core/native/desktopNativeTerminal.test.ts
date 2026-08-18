import { describe, expect, it, vi } from "vitest";
import { createDesktopNativeTerminalApi } from "./desktopNativeTerminal";

describe("desktop native terminal API", () => {
  it("maps lifecycle operations to the dedicated Sidecar terminal commands", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createDesktopNativeTerminalApi({
      invoke: invoke as unknown as Parameters<typeof createDesktopNativeTerminalApi>[0]["invoke"],
    });

    await api.create({
      cols: 100,
      rows: 30,
      shell: "powershell",
      terminalId: "terminal:workspace:1",
      workingDirectory: "D:\\code\\tinybot",
    });
    await api.poll({ cursor: 4, terminalId: "terminal:workspace:1", yieldTimeMs: 250 });
    await api.write({ cursor: 5, input: "dir\r", terminalId: "terminal:workspace:1" });
    await api.resize({ cols: 120, rows: 40, terminalId: "terminal:workspace:1" });
    await api.terminate("terminal:workspace:1");

    expect(invoke.mock.calls).toEqual([
      ["terminal_create", { input: { cols: 100, rows: 30, shell: "powershell", terminalId: "terminal:workspace:1", workingDirectory: "D:\\code\\tinybot" } }],
      ["terminal_poll", { input: { cursor: 4, terminalId: "terminal:workspace:1", yieldTimeMs: 250 } }],
      ["terminal_write", { input: { cursor: 5, input: "dir\r", terminalId: "terminal:workspace:1" } }],
      ["terminal_resize", { input: { cols: 120, rows: 40, terminalId: "terminal:workspace:1" } }],
      ["terminal_terminate", { input: { terminalId: "terminal:workspace:1" } }],
    ]);
  });
});
