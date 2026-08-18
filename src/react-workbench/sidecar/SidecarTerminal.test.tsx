// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativeTerminalRuntimeApi,
  NativeTerminalSnapshot,
} from "../../app-core/native/desktopNativeTerminal";
import { SidecarTerminal } from "./SidecarTerminal";
import { DEFAULT_SIDECAR_WORKSPACE_ID } from "./sidecarModel";

const xtermMocks = vi.hoisted(() => ({
  terminals: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    emitData: (value: string) => void;
    write: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    dispose = vi.fn();
    write = vi.fn();
    private dataHandler: (value: string) => void = () => undefined;

    constructor() {
      xtermMocks.terminals.push({
        dispose: this.dispose,
        emitData: (value) => this.dataHandler(value),
        write: this.write,
      });
    }

    loadAddon() {}
    open() {}
    onData(handler: (value: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

afterEach(() => {
  cleanup();
  xtermMocks.terminals.length = 0;
  vi.unstubAllGlobals();
});

describe("SidecarTerminal", () => {
  it("lets native resolve the working directory for the default workspace", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const runtime = terminalRuntime();
    vi.mocked(runtime.create).mockResolvedValue(snapshot({ running: false, status: "completed" }));

    render(
      <SidecarTerminal
        tab={{
          id: "terminal:default:1",
          kind: "terminal",
          shell: "powershell",
          title: "PowerShell",
          workspaceId: DEFAULT_SIDECAR_WORKSPACE_ID,
        }}
        terminalRuntime={runtime}
        workspaceLabel="General chats"
      />,
    );

    await waitFor(() => expect(runtime.create).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      shell: "powershell",
      terminalId: "terminal:default:1",
    }));
  });

  it("connects the PTY, serializes terminal input after polling, and leaves termination to the resource owner", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    let releasePoll: (snapshot: NativeTerminalSnapshot) => void = () => undefined;
    const pendingPoll = new Promise<NativeTerminalSnapshot>((resolve) => {
      releasePoll = resolve;
    });
    const runtime = terminalRuntime();
    vi.mocked(runtime.poll)
      .mockReturnValueOnce(pendingPoll)
      .mockImplementation(() => new Promise(() => undefined));
    const rendered = render(
      <SidecarTerminal
        tab={{
          id: "terminal:D%3A%2Fcode%2Ftinybot:1",
          kind: "terminal",
          shell: "powershell",
          title: "PowerShell",
          workspaceId: "D:/code/tinybot",
        }}
        terminalRuntime={runtime}
        workspaceLabel="tinybot"
      />,
    );

    await waitFor(() => expect(runtime.create).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      shell: "powershell",
      terminalId: "terminal:D%3A%2Fcode%2Ftinybot:1",
      workingDirectory: "D:/code/tinybot",
    }));
    expect(xtermMocks.terminals[0]?.write).toHaveBeenCalledWith("PS> ");

    xtermMocks.terminals[0]?.emitData("dir\r");
    expect(runtime.write).not.toHaveBeenCalled();
    releasePoll(snapshot({ cursor: 2, output: "", running: true }));
    await waitFor(() => expect(runtime.write).toHaveBeenCalledWith({
      cursor: 2,
      input: "dir\r",
      terminalId: "terminal:D%3A%2Fcode%2Ftinybot:1",
    }));

    rendered.unmount();
    expect(runtime.terminate).not.toHaveBeenCalled();
    expect(xtermMocks.terminals[0]?.dispose).toHaveBeenCalledOnce();
  });
});

function terminalRuntime(): NativeTerminalRuntimeApi {
  return {
    create: vi.fn(async () => snapshot({ cursor: 1, output: "PS> ", running: true })),
    poll: vi.fn(),
    resize: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    write: vi.fn(async () => snapshot({ cursor: 3, output: "dir\r\n", running: true })),
  };
}

function snapshot(overrides: Partial<NativeTerminalSnapshot> = {}): NativeTerminalSnapshot {
  return {
    cursor: 0,
    droppedBytes: 0,
    exitCode: null,
    failure: null,
    output: "",
    processId: "process-1",
    running: true,
    shell: "powershell",
    status: "running",
    terminalId: "terminal:D%3A%2Fcode%2Ftinybot:1",
    truncated: false,
    workingDirectory: "D:/code/tinybot",
    ...overrides,
  };
}
