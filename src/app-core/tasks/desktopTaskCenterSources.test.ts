import { describe, expect, test } from "vitest";
import { AGENT_UI_EVENT_TYPES, createAgentUiEventState, normalizeAgentUiEvents, reduceAgentUiEventState } from "../agent-ui/agentUiEvents";
import { DEFAULT_NATIVE_BACKEND_COMMAND } from "../gateway/desktopGatewayStartup";
import type { GatewayRuntimeStatus } from "../gateway/desktopGatewayStartup";
import {
  buildDesktopAgentUiApprovalTaskOperations,
  buildDesktopApprovalTaskOperations,
  buildDesktopFileTaskOperation,
  buildDesktopGatewayTaskOperation,
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

  test("projects gateway lifecycle snapshots into gateway task operations", () => {
    const starting: GatewayRuntimeStatus = {
      state: "starting",
      owner: "shell",
      http_ok: false,
      gateway_http: "http://127.0.0.1:18790",
      gateway_ws: "ws://127.0.0.1:18790/ws",
      command: DEFAULT_NATIVE_BACKEND_COMMAND,
      repo_root: "D:/Code/tinybot/tinybot",
      logs: ["booting"],
      last_error: null,
    };
    const failed = { ...starting, state: "offline" as const, owner: "none" as const, last_error: "port occupied" };

    expect(buildDesktopGatewayTaskOperation("startup", starting)).toEqual({
      id: "gateway:startup",
      title: "Start Tinybot gateway",
      status: "starting",
      detail: `shell / ${DEFAULT_NATIVE_BACKEND_COMMAND}`,
      canonical: { module: "gateway", href: "/api/status" },
      diagnostics: "booting",
      retryable: false,
      updatedAt: "",
    });
    expect(buildDesktopGatewayTaskOperation("restart", failed)).toMatchObject({
      id: "gateway:restart",
      title: "Restart Tinybot gateway",
      status: "failed",
      detail: `none / ${DEFAULT_NATIVE_BACKEND_COMMAND}`,
      canonical: { module: "gateway", href: "/api/status" },
      diagnostics: "port occupied",
      retryable: true,
    });
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
        turn_id: "run-1",
        payload: {
          form_id: "approval-form-1",
          title: "Approve deployment",
          correlation: { chat_id: "chat-1", message_id: "msg-1", turn_id: "run-1" },
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
