// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mountChatSurface } from "./chatSurface";
import type { ChatUiProjection } from "../../chat/chatUiProjection";

function dispatchSharedComposerSubmit(host: HTMLElement, content: string) {
  const detail = {
    accepted: false,
    content,
    handled: false,
    usePersistentRag: false,
  };
  host.dispatchEvent(new CustomEvent("desktop-chat-composer-submit-request", {
    bubbles: true,
    detail,
  }));
  return detail;
}

describe("rebuilt chat surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:10:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders projection-driven two-column shell without legacy thread ownership", () => {
    const host = document.createElement("section");

    const mounted = mountChatSurface(host, {
      projection: fixtureProjection(),
    });

    expect(host.getAttribute("data-chat-surface")).toBe("rebuild-chat-agent-surface");
    expect(host.querySelector("[data-chat-region='session-list']")).not.toBeNull();
    expect(host.querySelector("[data-chat-region='chat-detail']")).not.toBeNull();
    expect(host.querySelector("[data-chat-region='session-list']")?.textContent).toContain("Investigate IAM certificate");
    expect(host.querySelector("[data-session-primary-badge='waiting_approval']")?.textContent).toBe("Waiting approval");
    expect(host.querySelector("[data-chat-region='chat-header']")?.textContent).toContain("Investigate IAM certificate");
    expect(host.querySelector("[data-chat-region='chat-header']")?.textContent).toContain("Agent · rust");
    expect(host.querySelector("[data-chat-region='conversation']")?.textContent).toContain("Execution process · 2 tools");
    expect(host.querySelector("[data-chat-region='thinking-summary']")?.textContent).toContain("Looking at workspace docs.");
    expect(host.querySelector("[data-chat-region='tool-row']")?.textContent).toContain("workspace.read_file");
    expect(host.querySelector("[data-chat-region='conversation']")?.textContent).not.toContain("{\"path\":\"README.md\"}");
    expect(host.querySelector("[data-chat-region='conversation']")?.textContent).not.toContain("{\"path\":\"notes.md\"}");
    expect(host.querySelector("[data-chat-region='legacy-conversation-thread']")).toBeNull();

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("marks pinned sessions in the rebuilt session list", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.sessions[0].pinned = true;

    mountChatSurface(host, { projection });

    const row = host.querySelector("[data-session-key='websocket:chat-1']");
    expect(row?.getAttribute("data-pinned")).toBe("true");
    expect(row?.querySelector("[data-session-pinned]")?.textContent).toBe("Pinned");
  });

  test("shows updated time as the fallback session badge", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.sessions[0].primaryBadge = "updated_time";
    projection.sessions[0].updatedAt = "2026-07-01T10:05:00Z";

    mountChatSurface(host, { projection });

    expect(host.querySelector("[data-session-primary-badge='updated_time']")?.textContent).toBe("5 min");
  });

  test("renders tool detail in a right overlay drawer from projection state", () => {
    const host = document.createElement("section");
    const copies: unknown[] = [];
    host.addEventListener("desktop-chat-detail-copy", (event) => {
      copies.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.detailPanel = {
      kind: "tool",
      open: true,
      presentation: "drawer",
      targetId: "tool-1",
    };

    mountChatSurface(host, { projection });

    const drawer = host.querySelector("[data-chat-region='detail-surface']");
    expect(drawer?.getAttribute("data-detail-presentation")).toBe("drawer");
    expect(drawer?.getAttribute("data-detail-kind")).toBe("tool");
    expect(drawer?.textContent).toContain("workspace.read_file");
    expect(drawer?.textContent).toContain("README contents");
    expect(drawer?.querySelector("[data-tool-detail-section='full-args']")?.getAttribute("open")).toBeNull();
    expect(drawer?.querySelector("[data-tool-detail-section='full-result']")?.getAttribute("open")).toBeNull();
    expect(drawer?.querySelector("[data-tool-detail-copy='full-args']")).not.toBeNull();
    expect(drawer?.querySelector("[data-tool-detail-copy='full-result']")).not.toBeNull();

    drawer?.querySelector<HTMLButtonElement>("[data-tool-detail-copy='full-args']")?.click();

    expect(copies).toEqual([{
      content: "{\"path\":\"README.md\"}",
      source: "tool:full-args",
    }]);
  });

  test("opens and closes tool detail from a tool row click", () => {
    const host = document.createElement("section");
    const logEvents: unknown[] = [];
    host.addEventListener("desktop-chat-surface-log", (event) => {
      logEvents.push((event as CustomEvent).detail);
    });

    mountChatSurface(host, { projection: fixtureProjection() });

    expect(host.querySelector("[data-chat-region='detail-surface']")).toBeNull();

    host.querySelector<HTMLButtonElement>("[data-tool-call-id='tool-1']")?.click();

    const detail = host.querySelector("[data-chat-region='detail-surface']");
    expect(detail?.getAttribute("data-detail-kind")).toBe("tool");
    expect(detail?.textContent).toContain("workspace.read_file");

    host.querySelector<HTMLButtonElement>("[data-detail-action='close']")?.click();

    expect(host.querySelector("[data-chat-region='detail-surface']")).toBeNull();
    expect(logEvents).toEqual([
      {
        action: "detail.open",
        panel: {
          kind: "tool",
          open: true,
          presentation: "drawer",
          targetId: "tool-1",
        },
      },
      {
        action: "detail.close",
        panel: {
          kind: "none",
          open: false,
          presentation: "drawer",
        },
      },
    ]);
  });

  test("collapses completed process tools until the summary is expanded", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    const assistant = projection.turns.find((turn) => turn.id === "m-assistant");
    if (assistant?.process) {
      assistant.process.state = "completed";
    }

    mountChatSurface(host, { projection });

    const process = host.querySelector<HTMLButtonElement>("[data-chat-region='agent-process-summary']");
    expect(process?.getAttribute("data-agent-process-expanded")).toBe("false");
    expect(host.querySelector("[data-tool-call-id='tool-1']")).toBeNull();

    process?.click();

    expect(host.querySelector("[data-chat-region='agent-process-summary']")?.getAttribute("data-agent-process-expanded")).toBe("true");
    expect(host.querySelector("[data-tool-call-id='tool-1']")).not.toBeNull();

    host.querySelector<HTMLButtonElement>("[data-chat-region='agent-process-summary']")?.click();

    expect(host.querySelector("[data-chat-region='agent-process-summary']")?.getAttribute("data-agent-process-expanded")).toBe("false");
    expect(host.querySelector("[data-tool-call-id='tool-1']")).toBeNull();
  });

  test("renders fullscreen artifact and error detail from shared detail model", () => {
    const artifactHost = document.createElement("section");
    const artifactCopies: unknown[] = [];
    artifactHost.addEventListener("desktop-chat-detail-copy", (event) => {
      artifactCopies.push((event as CustomEvent).detail);
    });
    const artifactProjection = fixtureProjection();
    artifactProjection.detailPanel = {
      kind: "artifact",
      open: true,
      presentation: "fullscreen",
      targetId: "artifact-1",
    };
    artifactProjection.artifacts = [{
      id: "artifact-1",
      kind: "markdown",
      title: "Implementation report",
      preview: "Report preview",
      metadataSummary: "Generated by workspace.write_file",
      sourceTurnId: "m-assistant",
      openLabel: "Open file",
    }];

    mountChatSurface(artifactHost, { projection: artifactProjection });
    const artifactDetail = artifactHost.querySelector("[data-chat-region='detail-surface']");
    expect(artifactDetail?.getAttribute("data-detail-presentation")).toBe("fullscreen");
    expect(artifactDetail?.getAttribute("data-detail-kind")).toBe("artifact");
    expect(artifactDetail?.textContent).toContain("Implementation report");
    expect(artifactDetail?.textContent).toContain("Report preview");
    expect(artifactDetail?.querySelector("[data-detail-action='close']")).not.toBeNull();
    expect(artifactDetail?.querySelector("[data-artifact-action='future-management']")).not.toBeNull();
    artifactDetail?.querySelector<HTMLButtonElement>("[data-artifact-action='copy']")?.click();
    expect(artifactCopies).toEqual([{
      content: "Report preview",
      source: "artifact:artifact-1",
    }]);

    const errorHost = document.createElement("section");
    const errorCopies: unknown[] = [];
    errorHost.addEventListener("desktop-chat-detail-copy", (event) => {
      errorCopies.push((event as CustomEvent).detail);
    });
    const errorProjection = fixtureProjection();
    errorProjection.detailPanel = {
      kind: "error",
      open: true,
      presentation: "drawer",
      targetId: "error-1",
    };
    errorProjection.errors = [{
      id: "error-1",
      message: "Command failed",
      raw: "stack trace",
      relatedTurnId: "m-assistant",
      relatedToolId: "tool-1",
    }];

    mountChatSurface(errorHost, { projection: errorProjection });
    const errorDetail = errorHost.querySelector("[data-chat-region='detail-surface']");
    expect(errorDetail?.getAttribute("data-detail-kind")).toBe("error");
    expect(errorDetail?.textContent).toContain("Command failed");
    expect(errorDetail?.querySelector("[data-error-detail-section='raw']")?.getAttribute("open")).toBeNull();
    expect(errorDetail?.querySelector("[data-error-detail-copy='raw']")).not.toBeNull();
    errorDetail?.querySelector<HTMLButtonElement>("[data-error-detail-copy='raw']")?.click();
    expect(errorCopies).toEqual([{
      content: "stack trace",
      source: "error:error-1:raw",
    }]);
  });

  test("opens artifact detail from an artifact tool row", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.turns[1].tools = [{
      id: "artifact-1",
      name: "Artifact: Release draft",
      status: "completed",
      preview: "Release draft preview",
      argsPreview: "",
      resultPreview: "Release draft preview",
      detail: {
        argsText: "",
        responseText: "Release draft preview",
        stdout: "",
        stderr: "",
      },
      kind: "result",
    }];
    projection.artifacts = [{
      id: "artifact-1",
      kind: "artifact",
      title: "Release draft",
      preview: "Release draft preview",
      metadataSummary: "Status: completed",
      sourceTurnId: "m-assistant",
      sourceToolId: "artifact-1",
    }];

    mountChatSurface(host, { projection });

    const row = host.querySelector<HTMLButtonElement>("[data-tool-call-id='artifact-1']");
    expect(row?.getAttribute("data-tool-detail-kind")).toBe("artifact");
    row?.click();

    const detail = host.querySelector("[data-chat-region='detail-surface']");
    expect(detail?.getAttribute("data-detail-kind")).toBe("artifact");
    expect(detail?.textContent).toContain("Release draft");
    expect(detail?.textContent).toContain("Release draft preview");
  });

  test("renders live subagent strip and partial transcript as read-only detail", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-1",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Check docs",
      status: "user_intervened_unsynced",
      latestActivity: "User replied directly",
      capabilities: ["partial_transcript", "can_forward"],
      transcript: {
        id: "delegate-1",
        sessionKey: "websocket:chat-1",
        capability: "partial_transcript",
        messages: [{
          id: "sub-msg-1",
          role: "assistant",
          content: "I found a partial result.",
          timestamp: "2026-07-01T10:04:00Z",
        }],
        toolSummaries: [{
          id: "tool-sub",
          name: "workspace.read_file",
          status: "completed",
          preview: "read docs",
        }],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-1",
    };

    mountChatSurface(host, { projection });

    const strip = host.querySelector("[data-chat-region='subagent-strip']");
    expect(strip?.textContent).toContain("Researcher");
    expect(strip?.textContent).toContain("User replied directly");
    expect(strip?.querySelector("[data-subagent-status='user_intervened_unsynced']")).not.toBeNull();

    const detail = host.querySelector("[data-chat-region='detail-surface']");
    expect(detail?.getAttribute("data-detail-kind")).toBe("subagent");
    expect(detail?.textContent).toContain("partial transcript");
    expect(detail?.textContent).toContain("I found a partial result.");
    expect(detail?.textContent).toContain("not a complete private thread");
    expect(detail?.querySelector("[data-subagent-input='message']")).toBeNull();
    expect(detail?.querySelector("[data-subagent-action='forward']")).not.toBeNull();
  });

  test("opens subagent detail from the active goals strip", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-click",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Check docs",
      status: "waiting_main_agent",
      latestActivity: "Waiting for main agent",
      capabilities: ["partial_transcript", "can_forward"],
      transcript: {
        id: "delegate-click",
        sessionKey: "websocket:chat-1",
        capability: "partial_transcript",
        messages: [{ id: "sub-msg-click", role: "assistant", content: "Partial answer." }],
        toolSummaries: [],
      },
    }];

    mountChatSurface(host, { projection });

    host.querySelector<HTMLButtonElement>("[data-subagent-id='delegate-click']")?.click();

    const detail = host.querySelector("[data-chat-region='detail-surface']");
    expect(detail?.getAttribute("data-detail-kind")).toBe("subagent");
    expect(detail?.textContent).toContain("Researcher");
    expect(detail?.textContent).toContain("Partial answer.");
  });

  test("loads delegate trace when opening a partial subagent detail", async () => {
    const host = document.createElement("section");
    const logs: unknown[] = [];
    host.addEventListener("desktop-chat-surface-log", (event) => {
      logs.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-load",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Check docs",
      status: "running",
      latestActivity: "Partial activity",
      capabilities: ["partial_transcript", "can_forward"],
      transcript: {
        id: "delegate-load",
        sessionKey: "websocket:chat-1",
        capability: "partial_transcript",
        messages: [{ id: "sub-msg-load", role: "assistant", content: "Partial answer." }],
        toolSummaries: [],
      },
    }];
    const loadSubagentTranscript = vi.fn(async () => ({
      trace: {
        finalOutput: "Loaded final answer.",
        events: [{
          eventId: "event-loaded",
          eventType: "agent.delegate.completed",
          createdAt: "2026-07-01T10:05:00Z",
          payload: { finalOutput: "Loaded final answer." },
        }],
      },
    }));

    mountChatSurface(host, { projection, loadSubagentTranscript });

    host.querySelector<HTMLButtonElement>("[data-subagent-id='delegate-load']")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(loadSubagentTranscript).toHaveBeenCalledWith({
      activityId: "delegate-load",
      sessionKey: "websocket:chat-1",
      delegateId: "delegate-load",
    });
    const detail = host.querySelector("[data-chat-region='detail-surface']");
    expect(detail?.textContent).toContain("Loaded final answer.");
    expect(detail?.textContent).not.toContain("partial transcript");
    expect(logs).toEqual(expect.arrayContaining([
      {
        action: "subagent.trace.load.start",
        payload: {
          sessionKey: "websocket:chat-1",
          subagentId: "delegate-load",
        },
      },
      {
        action: "subagent.trace.load.complete",
        payload: {
          messageCount: 1,
          sessionKey: "websocket:chat-1",
          subagentId: "delegate-load",
          toolCount: 1,
        },
      },
    ]));
  });

  test("enables subagent input only for full sendable transcript", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-2",
      sessionKey: "websocket:chat-1",
      name: "Reviewer",
      task: "Review implementation",
      status: "waiting_user",
      latestActivity: "Needs product choice",
      capabilities: ["full_transcript", "can_send_message", "can_forward"],
      transcript: {
        id: "delegate-2",
        sessionKey: "websocket:chat-1",
        capability: "full_transcript",
        messages: [{
          id: "sub-msg-2",
          role: "assistant",
          content: "Which tradeoff should I choose?",
        }],
        toolSummaries: [],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-2",
    };

    mountChatSurface(host, { projection });

    expect(host.querySelector("[data-subagent-input='message']")).not.toBeNull();
    expect(host.querySelector("[data-chat-region='detail-surface']")?.textContent).toContain("Messages are sent only to this subagent");
  });

  test("forwards selected subagent messages into the shared bottom composer draft", () => {
    const host = document.createElement("section");
    const bottomComposer = document.createElement("textarea");
    bottomComposer.id = "desktop-native-composer-input";
    bottomComposer.value = "Continue from this context.";
    document.body.append(bottomComposer);
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-forward",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Review implementation",
      status: "waiting_user",
      latestActivity: "Needs product choice",
      capabilities: ["full_transcript", "can_send_message", "can_forward"],
      transcript: {
        id: "delegate-forward",
        sessionKey: "websocket:chat-1",
        capability: "full_transcript",
        messages: [
          { id: "sub-msg-user", role: "user", content: "Prefer lower risk." },
          { id: "sub-msg-assistant", role: "assistant", content: "Use read-only analysis." },
        ],
        toolSummaries: [],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-forward",
    };

    mountChatSurface(host, { projection });

    host.querySelector<HTMLInputElement>("[data-subagent-message-select='sub-msg-assistant']")!.checked = true;
    host.querySelector<HTMLButtonElement>("[data-subagent-action='forward']")?.click();

    expect(bottomComposer.value).toContain("Continue from this context.");
    expect(bottomComposer.value).toContain("Forwarded from subagent: Researcher");
    expect(bottomComposer.value).toContain("assistant: Use read-only analysis.");
    expect(bottomComposer.value).not.toContain("Prefer lower risk.");
    bottomComposer.remove();
  });

  test("preserves subagent message drafts by subagent panel", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [
      {
        id: "delegate-a",
        sessionKey: "websocket:chat-1",
        name: "Researcher A",
        task: "Review A",
        status: "waiting_user",
        latestActivity: "Needs product choice",
        capabilities: ["full_transcript", "can_send_message"],
        transcript: {
          id: "delegate-a",
          sessionKey: "websocket:chat-1",
          capability: "full_transcript",
          messages: [],
          toolSummaries: [],
        },
      },
      {
        id: "delegate-b",
        sessionKey: "websocket:chat-1",
        name: "Researcher B",
        task: "Review B",
        status: "waiting_user",
        latestActivity: "Needs product choice",
        capabilities: ["full_transcript", "can_send_message"],
        transcript: {
          id: "delegate-b",
          sessionKey: "websocket:chat-1",
          capability: "full_transcript",
          messages: [],
          toolSummaries: [],
        },
      },
    ];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-a",
    };
    const mounted = mountChatSurface(host, { projection });

    const firstInput = host.querySelector<HTMLTextAreaElement>("[data-subagent-input='message']");
    firstInput!.value = "Draft for A";
    firstInput!.dispatchEvent(new Event("input", { bubbles: true }));

    mounted.update({
      projection: {
        ...projection,
        detailPanel: { ...projection.detailPanel, targetId: "delegate-b" },
      },
    });
    expect(host.querySelector<HTMLTextAreaElement>("[data-subagent-input='message']")?.value).toBe("");

    mounted.update({ projection });
    expect(host.querySelector<HTMLTextAreaElement>("[data-subagent-input='message']")?.value).toBe("Draft for A");
  });

  test("submits direct messages only to sendable subagents", () => {
    const host = document.createElement("section");
    const submissions: unknown[] = [];
    host.addEventListener("desktop-chat-subagent-message-submit", (event) => {
      submissions.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-send",
      sessionKey: "websocket:chat-1",
      traceRef: "trace-send",
      childRunId: "child-send",
      name: "Reviewer",
      task: "Review implementation",
      status: "waiting_user",
      latestActivity: "Needs product choice",
      capabilities: ["full_transcript", "can_send_message"],
      transcript: {
        id: "delegate-send",
        sessionKey: "websocket:chat-1",
        capability: "full_transcript",
        messages: [],
        toolSummaries: [],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-send",
    };

    mountChatSurface(host, { projection });

    const input = host.querySelector<HTMLTextAreaElement>("[data-subagent-input='message']");
    input!.value = "Use the safer option.";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>("[data-subagent-action='send-message']")?.click();

    expect(submissions).toEqual([{
      childRunId: "child-send",
      content: "Use the safer option.",
      sessionKey: "websocket:chat-1",
      subagentId: "delegate-send",
      traceRef: "trace-send",
    }]);
    expect(host.querySelector<HTMLTextAreaElement>("[data-subagent-input='message']")?.value).toBe("");
    expect(host.querySelector("[data-chat-region='detail-surface']")?.textContent).toContain("Use the safer option.");
    expect(host.querySelector("[data-subagent-status]")?.getAttribute("data-subagent-status")).toBe("user_intervened_unsynced");
  });

  test("requires first-send confirmation for waiting-main-agent subagent messages", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-waiting-main",
      sessionKey: "websocket:chat-1",
      name: "Implementer",
      task: "Wait for main agent context",
      status: "waiting_main_agent",
      latestActivity: "Waiting for main agent",
      capabilities: ["full_transcript", "can_send_message", "can_forward"],
      transcript: {
        id: "delegate-waiting-main",
        sessionKey: "websocket:chat-1",
        capability: "full_transcript",
        messages: [],
        toolSummaries: [],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-waiting-main",
    };

    mountChatSurface(host, { projection });

    const confirmation = host.querySelector("[data-subagent-action='first-send-confirm']");
    expect(confirmation).not.toBeNull();
    expect(confirmation?.textContent).toContain("Confirm first direct message");
    expect(host.querySelector("[data-subagent-input='message']")?.getAttribute("data-requires-confirmation")).toBe("true");
  });

  test("keeps completed subagent details read-only", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.liveSubagents = [{
      id: "delegate-completed",
      sessionKey: "websocket:chat-1",
      name: "Researcher",
      task: "Completed research",
      status: "completed",
      latestActivity: "Finished",
      capabilities: ["full_transcript", "can_send_message", "can_forward"],
      transcript: {
        id: "delegate-completed",
        sessionKey: "websocket:chat-1",
        capability: "full_transcript",
        messages: [{ id: "done-1", role: "assistant", content: "Done." }],
        toolSummaries: [],
      },
    }];
    projection.detailPanel = {
      kind: "subagent",
      open: true,
      presentation: "drawer",
      targetId: "delegate-completed",
    };

    mountChatSurface(host, { projection });

    expect(host.querySelector("[data-subagent-input='message']")).toBeNull();
    expect(host.querySelector("[data-chat-region='detail-surface']")?.textContent).toContain("This subagent is closed");
  });

  test("renders inline approval card and queued input near composer", () => {
    const host = document.createElement("section");
    const approvalActions: unknown[] = [];
    host.addEventListener("desktop-tool-approval-action", (event) => {
      approvalActions.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.approvals = [{
      id: "approval-1",
      sessionKey: "websocket:chat-1",
      toolName: "workspace.write_file",
      status: "pending",
      scopeKey: "filesystem.write:workspace",
      scopeLabel: "Allow workspace writes for this session",
      prompt: "Allow writing notes.md?",
      choices: ["allow_once", "allow_session", "deny"],
    }];
    projection.queuedInputs = [{
      id: "queued-1",
      mode: "queued",
      content: "Summarize after this.",
      createdAt: "2026-07-01T10:20:00Z",
      status: "queued",
    }];

    mountChatSurface(host, { projection });

    const approval = host.querySelector("[data-chat-region='approval-card']");
    expect(approval?.textContent).toContain("Allow writing notes.md?");
    expect(approval?.textContent).toContain("Allow once");
    expect(approval?.textContent).toContain("Allow workspace writes for this session");
    expect(host.querySelector("[data-composer-mode='approval_guidance']")?.textContent).toContain("发送文字将拒绝此请求");

    host.querySelector<HTMLButtonElement>("[data-desktop-approval-action='approveOnce']")?.click();
    host.querySelector<HTMLButtonElement>("[data-desktop-approval-action='approveSession']")?.click();
    host.querySelector<HTMLButtonElement>("[data-desktop-approval-action='deny']")?.click();
    expect(approvalActions).toEqual([
      {
        action: "approveOnce",
        approvalId: "approval-1",
        sessionKey: "websocket:chat-1",
        toolName: "workspace.write_file",
      },
      {
        action: "approveSession",
        approvalId: "approval-1",
        sessionKey: "websocket:chat-1",
        toolName: "workspace.write_file",
      },
      {
        action: "deny",
        approvalId: "approval-1",
        sessionKey: "websocket:chat-1",
        toolName: "workspace.write_file",
      },
    ]);

    const queue = host.querySelector("[data-chat-region='queued-inputs']");
    expect(queue?.textContent).toContain("Summarize after this.");
    expect(queue?.querySelector("[data-queued-input-action='delete']")).not.toBeNull();
    expect(queue?.querySelector("[data-queued-input-action='guide']")).toBeNull();
  });

  test("dispatches a branch session draft from a selected turn", () => {
    const host = document.createElement("section");
    const branchRequests: unknown[] = [];
    host.addEventListener("desktop-chat-branch-session-request", (event) => {
      branchRequests.push((event as CustomEvent).detail);
    });

    mountChatSurface(host, { projection: fixtureProjection() });

    host.querySelector<HTMLButtonElement>("[data-chat-turn-id='m-assistant'] [data-turn-action='branch']")?.click();

    expect(branchRequests).toEqual([{
      title: "Investigate IAM certificate · 分叉",
      branchedFromSessionId: "websocket:chat-1",
      branchedFromMessageId: "m-assistant",
      messages: [
        { messageId: "m-user", role: "user", content: "Check the cert setup." },
        { messageId: "m-assistant", role: "assistant", content: "I found the relevant file." },
      ],
      portableContext: {
        chatId: "chat-1",
        sessionKey: "websocket:chat-1",
      },
      runtimeState: {},
    }]);
  });

  test("supports session list search, new chat, and opening a session", () => {
    const host = document.createElement("section");
    const newEvents: unknown[] = [];
    const openEvents: unknown[] = [];
    host.addEventListener("desktop-chat-session-new", (event) => {
      newEvents.push((event as CustomEvent).detail);
    });
    host.addEventListener("desktop-chat-session-open", (event) => {
      openEvents.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.sessions.push({
      key: "websocket:chat-2",
      chatId: "chat-2",
      title: "CloudFront certificate",
      createdAt: "2026-07-01T09:00:00Z",
      updatedAt: "2026-07-01T09:05:00Z",
      primaryBadge: "updated_time",
      isActive: false,
    });

    mountChatSurface(host, { projection });

    expect(host.querySelectorAll("[data-session-key]")).toHaveLength(2);
    host.querySelector<HTMLButtonElement>("[data-session-action='new']")?.click();
    expect(newEvents).toEqual([{}]);

    const search = host.querySelector<HTMLInputElement>("[data-session-search]");
    search!.value = "cloud";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(Array.from(host.querySelectorAll("[data-session-key]")).map((row) => row.getAttribute("data-session-key"))).toEqual([
      "websocket:chat-2",
    ]);

    host.querySelector<HTMLButtonElement>("[data-session-key='websocket:chat-2']")?.click();
    expect(openEvents).toEqual([{
      chatId: "chat-2",
      sessionKey: "websocket:chat-2",
    }]);

    search!.value = "missing";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(host.querySelector("[data-session-empty]")?.textContent).toBe("No matching sessions");
  });

  test("dispatches header session actions with copy payloads", () => {
    const host = document.createElement("section");
    const actions: unknown[] = [];
    host.addEventListener("desktop-chat-session-action", (event) => {
      actions.push((event as CustomEvent).detail);
    });

    mountChatSurface(host, { projection: fixtureProjection() });

    host.querySelector<HTMLButtonElement>("[data-chat-header-action='pin']")?.click();
    host.querySelector<HTMLButtonElement>("[data-chat-header-action='copy-session-id']")?.click();
    host.querySelector<HTMLButtonElement>("[data-chat-header-action='copy-markdown']")?.click();

    expect(actions).toEqual([
      {
        action: "pin",
        chatId: "chat-1",
        sessionKey: "websocket:chat-1",
        title: "Investigate IAM certificate",
      },
      {
        action: "copy-session-id",
        chatId: "chat-1",
        copyText: "websocket:chat-1",
        sessionKey: "websocket:chat-1",
        title: "Investigate IAM certificate",
      },
      {
        action: "copy-markdown",
        chatId: "chat-1",
        copyText: "User:\nCheck the cert setup.\n\nAssistant:\nI found the relevant file.",
        sessionKey: "websocket:chat-1",
        title: "Investigate IAM certificate",
      },
    ]);
  });

  test("dispatches unpin when the active session is pinned", () => {
    const host = document.createElement("section");
    const actions: unknown[] = [];
    host.addEventListener("desktop-chat-session-action", (event) => {
      actions.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.sessions[0].pinned = true;

    mountChatSurface(host, { projection });

    const pinButton = host.querySelector<HTMLButtonElement>("[data-chat-header-action='unpin']");
    expect(pinButton?.textContent).toBe("Unpin");
    pinButton?.click();

    expect(actions).toEqual([{
      action: "unpin",
      chatId: "chat-1",
      sessionKey: "websocket:chat-1",
      title: "Investigate IAM certificate",
    }]);
  });

  test("dispatches message copy actions from turn rows", () => {
    const host = document.createElement("section");
    const copies: unknown[] = [];
    host.addEventListener("desktop-chat-message-copy", (event) => {
      copies.push((event as CustomEvent).detail);
    });

    mountChatSurface(host, { projection: fixtureProjection() });

    host.querySelector<HTMLButtonElement>("[data-chat-turn-id='m-assistant'] [data-turn-action='copy']")?.click();

    expect(copies).toEqual([{
      content: "I found the relevant file.",
      messageId: "m-assistant",
      role: "assistant",
    }]);
  });

  test("does not render a second main composer inside the chat surface", () => {
    const host = document.createElement("section");

    mountChatSurface(host, { projection: fixtureProjection() });

    expect(host.querySelector("[data-chat-composer-input]")).toBeNull();
    expect(host.querySelector("[data-chat-composer-action='send']")).toBeNull();
  });

  test("submits shared bottom composer text as a main chat message event", () => {
    const host = document.createElement("section");
    const submissions: unknown[] = [];
    host.addEventListener("desktop-chat-message-submit", (event) => {
      submissions.push((event as CustomEvent).detail);
    });

    mountChatSurface(host, { projection: fixtureProjection() });

    const request = dispatchSharedComposerSubmit(host, "Continue with the local docs.");

    expect(submissions).toEqual([{ content: "Continue with the local docs." }]);
    expect(request.handled).toBe(true);
    expect(request.accepted).toBe(true);
  });

  test("submits shared bottom composer text as approval guidance while approval is pending", () => {
    const host = document.createElement("section");
    const guidanceSubmissions: unknown[] = [];
    host.addEventListener("desktop-chat-approval-guidance-submit", (event) => {
      guidanceSubmissions.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.approvals = [{
      id: "approval-1",
      sessionKey: "websocket:chat-1",
      toolName: "workspace.write_file",
      status: "pending",
      prompt: "Allow writing notes.md?",
      choices: ["allow_once", "allow_session", "deny"],
    }];

    mountChatSurface(host, { projection });

    const request = dispatchSharedComposerSubmit(host, "Do not write files; summarize only.");

    expect(guidanceSubmissions).toEqual([{
      approvalId: "approval-1",
      guidance: "Do not write files; summarize only.",
    }]);
    expect(request.handled).toBe(true);
    expect(request.accepted).toBe(true);
    expect(host.querySelector("[data-chat-region='queued-inputs']")).toBeNull();
  });

  test("queues shared bottom composer text while the assistant turn is running and supports deleting it", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.turns[1] = {
      ...projection.turns[1],
      process: {
        state: "running",
        summary: "Execution process · 2 tools",
        toolCount: 2,
      },
    };

    mountChatSurface(host, { projection });

    const request = dispatchSharedComposerSubmit(host, "Summarize after the tools finish.");

    const queue = host.querySelector("[data-chat-region='queued-inputs']");
    expect(queue?.textContent).toContain("Summarize after the tools finish.");
    expect(request.handled).toBe(true);
    expect(request.accepted).toBe(true);

    host.querySelector<HTMLButtonElement>("[data-queued-input-action='delete']")?.click();

    expect(host.querySelector("[data-chat-region='queued-inputs']")).toBeNull();
  });

  test("continues a paused queue by sending only the next queued input", () => {
    const host = document.createElement("section");
    const submissions: unknown[] = [];
    host.addEventListener("desktop-chat-message-submit", (event) => {
      submissions.push((event as CustomEvent).detail);
    });
    const projection = fixtureProjection();
    projection.queuedInputs = [
      {
        id: "queued-a",
        mode: "queued",
        content: "First paused message.",
        createdAt: "2026-07-01T10:20:00Z",
        status: "paused",
      },
      {
        id: "queued-b",
        mode: "queued",
        content: "Second paused message.",
        createdAt: "2026-07-01T10:21:00Z",
        status: "paused",
      },
    ];

    mountChatSurface(host, { projection });

    expect(host.querySelector("[data-chat-region='queued-inputs']")?.textContent).toContain("Queue paused");
    host.querySelector<HTMLButtonElement>("[data-queued-input-action='continue']")?.click();

    expect(submissions).toEqual([{ content: "First paused message." }]);
    expect(host.querySelector("[data-chat-region='queued-inputs']")?.textContent).not.toContain("First paused message.");
    expect(host.querySelector("[data-chat-region='queued-inputs']")?.textContent).toContain("Second paused message.");
  });

  test("renders resolved approvals as compact history results", () => {
    const host = document.createElement("section");
    const projection = fixtureProjection();
    projection.approvals = [{
      id: "approval-resolved",
      sessionKey: "websocket:chat-1",
      toolName: "workspace.read_file",
      status: "approved",
      prompt: "Allowed once",
      choices: ["allow_once", "allow_session", "deny"],
    }];

    mountChatSurface(host, { projection });

    const result = host.querySelector("[data-chat-region='approval-result']");
    expect(result?.textContent).toContain("Approved");
    expect(result?.textContent).toContain("workspace.read_file");
    expect(host.querySelector("[data-chat-region='approval-card']")).toBeNull();
  });
});

function fixtureProjection(): ChatUiProjection {
  return {
    activeSessionKey: "websocket:chat-1",
    sessions: [{
      key: "websocket:chat-1",
      chatId: "chat-1",
      title: "Investigate IAM certificate",
      createdAt: "2026-07-01T10:00:00Z",
      updatedAt: "2026-07-01T10:05:00Z",
      primaryBadge: "waiting_approval",
      isActive: true,
    }],
    turns: [
      {
        id: "m-user",
        role: "user",
        content: "Check the cert setup.",
        reasoningContent: "",
        timestamp: "2026-07-01T10:01:00Z",
        tools: [],
      },
      {
        id: "m-assistant",
        role: "assistant",
        content: "I found the relevant file.",
        reasoningContent: "Looking at workspace docs.",
        timestamp: "2026-07-01T10:02:00Z",
        process: {
          state: "waiting_approval",
          summary: "Execution process · 2 tools",
          toolCount: 2,
        },
        tools: [
          {
            id: "tool-1",
            name: "workspace.read_file",
            status: "completed",
            preview: "README contents",
            argsPreview: "{\"path\":\"README.md\"}",
            resultPreview: "README contents",
            detail: {
              argsText: "{\"path\":\"README.md\"}",
              responseText: "README contents",
              stdout: "",
              stderr: "",
            },
            kind: "result",
          },
          {
            id: "approval-1",
            name: "workspace.write_file",
            status: "waiting_approval",
            preview: "Needs approval",
            argsPreview: "{\"path\":\"notes.md\"}",
            resultPreview: "Needs approval",
            detail: {
              argsText: "{\"path\":\"notes.md\"}",
              responseText: "Needs approval",
              stdout: "",
              stderr: "",
            },
            kind: "result",
            approvalId: "approval-1",
          },
        ],
      },
    ],
    approvals: [],
    liveSubagents: [],
    queuedInputs: [],
    detailPanel: {
      kind: "none",
      open: false,
      presentation: "drawer",
    },
    branchSource: {
      canBranchSession: true,
      portableContextKeys: ["chatId", "sessionKey"],
      runtimeStateExcluded: true,
    },
  };
}
