import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import { NativeWorkspaceBridge } from "./workspaceBridge";

class FakeRpcClient {
  readonly calls: Array<{ traceId: string; method: string; params: JsonObject }> = [];

  constructor(private readonly responses: unknown[]) {}

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.calls.push({ traceId, method, params });
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

describe("NativeWorkspaceBridge", () => {
  test("marks WebUI workspace writes as internal native operations", async () => {
    const rpc = new FakeRpcClient([{ path: "notes/today.md", updated_at: "2026-06-24T02:00:00Z" }]);
    const bridge = new NativeWorkspaceBridge(rpc);

    await expect(bridge.writeFile("notes/today.md", "hello", "trace-1", "previous")).resolves.toEqual({
      path: "notes/today.md",
      updatedAt: "2026-06-24T02:00:00Z",
    });

    expect(rpc.calls).toEqual([
      {
        traceId: "trace-1",
        method: "workspace.write_file",
        params: {
          path: "notes/today.md",
          contents: "hello",
          expected_updated_at: "previous",
          internal_operation: true,
        },
      },
    ]);
  });
});
