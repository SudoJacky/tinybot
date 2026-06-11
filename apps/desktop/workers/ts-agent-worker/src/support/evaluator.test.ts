import { describe, expect, test } from "vitest";

import {
  buildEvaluatorMessages,
  EVALUATE_NOTIFICATION_TOOL,
  parseEvaluatorDecision,
} from "./evaluator";

const templates = {
  "agent/evaluator.md": [
    "{% if part == 'system' %}",
    "System gate",
    "{% elif part == 'user' %}",
    "Task: {{ task_context }}",
    "Response: {{ response }}",
    "{% endif %}",
  ].join("\n"),
};

describe("evaluator", () => {
  test("builds evaluator messages from templates", () => {
    expect(buildEvaluatorMessages({
      templates,
      taskContext: "check CI",
      response: "tests failed",
    })).toEqual([
      { role: "system", content: "System gate" },
      { role: "user", content: "Task: check CI\nResponse: tests failed" },
    ]);
  });

  test("exposes the Python-compatible evaluate_notification tool schema", () => {
    expect(EVALUATE_NOTIFICATION_TOOL).toMatchObject({
      type: "function",
      function: {
        name: "evaluate_notification",
        parameters: {
          type: "object",
          required: ["should_notify"],
        },
      },
    });
  });

  test("parses evaluator tool decisions and defaults to notify on weak evidence", () => {
    expect(parseEvaluatorDecision({
      toolCalls: [{ name: "evaluate_notification", arguments: { should_notify: false, reason: "routine" } }],
    })).toEqual({ shouldNotify: false, reason: "routine" });

    expect(parseEvaluatorDecision({ toolCalls: [] })).toEqual({ shouldNotify: true, reason: "missing_tool_call" });
    expect(parseEvaluatorDecision({
      toolCalls: [{ name: "other", argumentsJson: "{\"should_notify\":false}" }],
    })).toEqual({ shouldNotify: true, reason: "missing_tool_call" });
  });

  test("parses JSON argument strings when provider adapters expose raw tool arguments", () => {
    expect(parseEvaluatorDecision({
      toolCalls: [{ name: "evaluate_notification", argumentsJson: "{\"should_notify\":true,\"reason\":\"deliverable\"}" }],
    })).toEqual({ shouldNotify: true, reason: "deliverable" });
  });
});
