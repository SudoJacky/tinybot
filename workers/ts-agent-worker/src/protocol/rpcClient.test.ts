import { describe, expect, test } from "vitest";

import { RpcClient } from "./rpcClient";

describe("RpcClient", () => {
  test("writes a worker request and resolves it from a matching response", async () => {
    const lines: string[] = [];
    const rpc = new RpcClient({ writeLine: (line) => lines.push(line) });

    const pending = rpc.request("trace-1", "workspace.list_files", {});

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        protocol_version: "1",
        id: "worker-req-1",
        trace_id: "trace-1",
        method: "workspace.list_files",
        params: {},
      },
    ]);

    expect(
      rpc.handleResponse({
        protocol_version: "1",
        id: "worker-req-1",
        trace_id: "trace-1",
        result: [{ path: "README.md", kind: "file", bytes: 12 }],
      }),
    ).toBe(true);
    await expect(pending).resolves.toEqual([{ path: "README.md", kind: "file", bytes: 12 }]);
  });

  test("rejects a matching protocol error response", async () => {
    const rpc = new RpcClient({ writeLine: () => undefined });
    const pending = rpc.request("trace-1", "workspace.read_file", { path: "missing.md" });

    rpc.handleResponse({
      protocol_version: "1",
      id: "worker-req-1",
      trace_id: "trace-1",
      error: {
        code: "worker_error",
        message: "failed to read workspace file",
        details: { path: "missing.md" },
        retryable: false,
        source: "rust_core",
      },
    });

    await expect(pending).rejects.toThrow("failed to read workspace file");
  });
});
