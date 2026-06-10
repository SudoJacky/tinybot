import { describe, expect, test } from "vitest";
import { NativeSessionBridge } from "./sessionBridge";

describe("NativeSessionBridge", () => {
  test("serializes agent messages with native snake_case tool fields before appending", async () => {
    const requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
    const bridge = new NativeSessionBridge({
      request: async (traceId, method, params) => {
        requests.push({ traceId, method, params });
        return { ok: true };
      },
    });

    await bridge.appendMessages(
      "session-1",
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
        {
          role: "tool",
          content: "README contents",
          toolCallId: "call-read",
          name: "read_file",
        },
      ],
      "trace-1",
    );

    expect(requests).toEqual([
      {
        traceId: "trace-1",
        method: "session.append_messages",
        params: {
          session_id: "session-1",
          messages: [
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              content: "README contents",
              tool_call_id: "call-read",
              name: "read_file",
            },
          ],
        },
      },
    ]);
  });
});
