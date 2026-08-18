export type NativeTerminalShell = "powershell" | "cmd";

export type NativeTerminalSnapshot = {
  cursor: number;
  droppedBytes: number;
  exitCode: number | null;
  failure: string | null;
  output: string;
  processId: string;
  running: boolean;
  shell: NativeTerminalShell;
  status: string;
  terminalId: string;
  truncated: boolean;
  workingDirectory: string;
};

export type NativeTerminalRuntimeApi = {
  create(input: {
    cols: number;
    rows: number;
    shell: NativeTerminalShell;
    terminalId: string;
    workingDirectory: string;
  }): Promise<NativeTerminalSnapshot>;
  poll(input: {
    cursor: number;
    terminalId: string;
    yieldTimeMs?: number;
  }): Promise<NativeTerminalSnapshot>;
  resize(input: { cols: number; rows: number; terminalId: string }): Promise<void>;
  terminate(terminalId: string): Promise<void>;
  write(input: { cursor: number; input: string; terminalId: string }): Promise<NativeTerminalSnapshot>;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createDesktopNativeTerminalApi(options: { invoke: Invoke }): NativeTerminalRuntimeApi {
  const invokeInput = <T>(command: string, input: unknown): Promise<T> => (
    options.invoke<T>(command, { input })
  );
  return {
    create: (input) => invokeInput("terminal_create", input),
    poll: (input) => invokeInput("terminal_poll", input),
    resize: (input) => invokeInput("terminal_resize", input),
    terminate: (terminalId) => invokeInput("terminal_terminate", { terminalId }),
    write: (input) => invokeInput("terminal_write", input),
  };
}
