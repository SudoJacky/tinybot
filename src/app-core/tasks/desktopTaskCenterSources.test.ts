import { describe, expect, test } from "vitest";
import { AGENT_UI_EVENT_TYPES, createAgentUiEventState, normalizeAgentUiEvents, reduceAgentUiEventState } from "../agent-ui/agentUiEvents";
import {
  buildDesktopAgentUiApprovalTaskOperations,
  buildDesktopApprovalTaskOperations,
  buildDesktopFileTaskOperation,
  buildDesktopProviderModelDiscoveryTaskOperation,
} from "./desktopTaskCenterSources";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";

describe("desktop task center source projections", () => {
  test("projects provider model discovery into provider task operations", () => {
    expect(
      [
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "openai",
          profile: "work",
          status: "refreshing",
          updatedAt: "2026-05-31T13:00:00Z",
        }),
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "deepseek",
          profile: "default",
          status: "completed",
          models: ["deepseek-chat", "deepseek-reasoner"],
        }),
        buildDesktopProviderModelDiscoveryTaskOperation({
          provider: "anthropic",
          status: "failed",
          error: "HTTP 401",
        }),
      ],
    ).toEqual([
      {
        id: "provider:openai:work:models",
        title: "Refresh OpenAI models",
        status: "refreshing",
        detail: "Profile work",
        canonical: { module: "settings", entityId: "openai", href: "/settings" },
        diagnostics: "",
        retryable: false,
        updatedAt: "2026-05-31T13:00:00Z",
      },
      {
        id: "provider:deepseek:default:models",
        title: "Refresh Deepseek models",
        status: "completed",
        detail: "2 models loaded",
        canonical: { module: "settings", entityId: "deepseek", href: "/settings" },
        diagnostics: "",
        retryable: false,
        updatedAt: "",
      },
      {
        id: "provider:anthropic:default:models",
        title: "Refresh Anthropic models",
        status: "failed",
        detail: "Profile default",
        canonical: { module: "settings", entityId: "anthropic", href: "/settings" },
        diagnostics: "HTTP 401",
        retryable: true,
        updatedAt: "",
      },
    ]);
  });

  test("projects file operations and blocked approvals into task center items", () => {
    const state = createAgentUiEventState();
    for (const event of normalizeAgentUiEvents({
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.requested"],
        chat_id: "chat-1",
        message_id: "msg-1",
        turn_id: "turn-1",
        payload: {
          form_id: "approval-form-1",
          title: "Approve deployment",
          correlation: { chat_id: "chat-1", message_id: "msg-1", turn_id: "turn-1" },
          fields: [{ name: "confirm", type: "checkbox", label: "Confirm", required: true }],
        },
      },
    })) {
      reduceAgentUiEventState(state, event);
    }

    const taskItems = buildDesktopTaskCenterItems({
      fileOperations: [
        buildDesktopFileTaskOperation({
          id: "workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "saving",
          path: "AGENTS.md",
        }),
        buildDesktopFileTaskOperation({
          id: "workspace:AGENTS.md:save",
          title: "Save AGENTS.md",
          status: "failed",
          path: "AGENTS.md",
          detail: "Save conflict",
          error: "HTTP 409",
          retryable: true,
        }),
      ],
      approvals: [
        ...buildDesktopAgentUiApprovalTaskOperations(state),
        ...buildDesktopApprovalTaskOperations({
          approvals: [
            {
              id: "approval-1",
              summary: "Shell command approval required",
              tool_name: "shell_command",
              risk: "high",
              session_key: "WebSocket:chat-1",
            },
          ],
        }),
      ],
    });

    expect(taskItems.map((item) => [item.id, item.source, item.state, item.title, item.actions.map((action) => action.id).join(",")])).toEqual([
      ["approval:form:approval-form-1", "approval", "blocked", "Approve deployment", "open,inspect"],
      ["approval:approval-1", "approval", "blocked", "Approve shell_command", "approveOnce,approveSession,deny,open,inspect"],
      ["file:workspace:AGENTS.md:save", "file", "failed", "Save AGENTS.md", "retry,open,inspect,copyDiagnostics,dismiss"],
      ["file:workspace:AGENTS.md:save", "file", "active", "Save AGENTS.md", "open,inspect"],
    ]);
    expect(taskItems.find((item) => item.id === "approval:approval-1")?.approval).toEqual({
      approvalId: "approval-1",
      sessionKey: "WebSocket:chat-1",
    });
  });
});
