import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import { createNativeReadOnlyTools } from "./nativeToolProxy";

class FakeRpcClient {
  readonly requests: Array<{ traceId: string; method: string; params: JsonObject }> = [];
  private readonly responses: unknown[];

  constructor(responses: unknown[]) {
    this.responses = responses;
  }

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe("createNativeReadOnlyTools", () => {
  test("creates a read_file tool backed by workspace.read_file", async () => {
    const rpc = new FakeRpcClient([{ path: "README.md", contents: "hello\nworld" }]);
    const [readFile] = createNativeReadOnlyTools(rpc);

    const result = await readFile.execute({ path: "README.md" }, { runId: "run-1", traceId: "trace-1" });

    expect(readFile.name).toBe("read_file");
    expect(result.content).toBe("hello\nworld");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.read_file",
        params: { path: "README.md" },
      },
    ]);
  });

  test("creates a list_dir tool backed by workspace.list_files", async () => {
    const rpc = new FakeRpcClient([
      [
        { path: "README.md", kind: "file", bytes: 12 },
        { path: "src/index.ts", kind: "file", bytes: 100 },
      ],
    ]);
    const [, listDir] = createNativeReadOnlyTools(rpc);

    const result = await listDir.execute({}, { runId: "run-1", traceId: "trace-1" });

    expect(listDir.name).toBe("list_dir");
    expect(result.content).toBe("README.md\nsrc/index.ts");
    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.list_files",
        params: {},
      },
    ]);
  });
});
