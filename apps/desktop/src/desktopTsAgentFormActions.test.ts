import { describe, expect, test } from "vitest";
import type { AgentUiForm } from "./agentUiEvents";
import { buildDesktopTsAgentFormSubmissionInput } from "./desktopTsAgentFormActions";

const baseForm: AgentUiForm = {
  form_id: "travel_plan",
  title: "Travel plan",
  fields: [{ name: "destination", type: "text", label: "Destination", required: true }],
  correlation: {
    run_id: "run-1",
    session_id: "WebSocket:chat-1",
  },
  status: "pending",
};

describe("desktop TS agent form actions", () => {
  test("builds worker submit input from an Agent UI form request", () => {
    expect(buildDesktopTsAgentFormSubmissionInput(
      baseForm,
      {
        values: { destination: "Paris" },
        correlation: { session_id: "WebSocket:chat-request" },
      },
      "submit",
    )).toEqual({
      sessionId: "WebSocket:chat-request",
      formId: "travel_plan",
      values: { destination: "Paris" },
      action: "submitted",
    });
  });

  test("builds worker cancel input with a fallback session id", () => {
    expect(buildDesktopTsAgentFormSubmissionInput(
      { ...baseForm, correlation: {} },
      { correlation: {} },
      "cancel",
      "WebSocket:chat-fallback",
    )).toEqual({
      sessionId: "WebSocket:chat-fallback",
      formId: "travel_plan",
      values: {},
      action: "cancelled",
    });
  });
});
