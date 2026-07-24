import { describe, expect, test } from "vitest";
import type { ChatTurn } from "./chatTurnModel";
import {
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
  createTinyOsAgentRequestChangeCommand,
  createTinyOsAgentTurnControlCommand,
  createTinyOsApprovalResolveCommand,
  createTinyOsFormCancelCommand,
  createTinyOsFormSubmitCommand,
  createTinyOsBrowserInteractCommand,
  createTinyOsFileDeleteCommand,
  createTinyOsFileMoveCommand,
  createTinyOsFileSaveCommand,
  createTinyOsOperationRetryCommand,
  createTinyOsTerminalCancelCommand,
  createTinyOsTerminalExecuteCommand,
  isTinyOsCommandInFlight,
  isTinyOsCommandPending,
  reduceTinyOsCommandLifecycle,
  type TinyOsCommandLifecycle,
} from "./tinyOsCommandGateway";

const command = createTinyOsAgentCancelCommand({
  commandId: "command-1",
  issuedAt: "2026-07-13T00:00:00Z",
  turnId: "turn-1",
  sessionId: "websocket:chat-1",
  source: { control: "stop-response", surface: "chat" },
});

describe("TinyOS command lifecycle", () => {
  test("creates a correlated approval resolution command", () => {
    expect(createTinyOsApprovalResolveCommand({
      action: "approveSession",
      approvalId: "approval-1",
      commandId: "command-approval-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "inspector-approval", surface: "tinyos" },
    })).toMatchObject({
      approval: { approvalId: "approval-1", approved: true, scope: "session" },
      commandId: "command-approval-1",
      kind: "approval.resolve",
    });
  });

  test("creates a correlated form submission command", () => {
    expect(createTinyOsFormSubmitCommand({
      commandId: "command-form-1",
      formId: "travel-preferences-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "system-form", surface: "tinyos" },
      values: { destination: "Singapore", nights: 4 },
    })).toMatchObject({
      commandId: "command-form-1",
      form: {
        formId: "travel-preferences-1",
        values: { destination: "Singapore", nights: 4 },
      },
      kind: "form.submit",
    });
  });

  test("creates pause and resume commands for the same turn identity", () => {
    const pause = createTinyOsAgentTurnControlCommand({
      commandId: "command-pause-1",
      issuedAt: "2026-07-13T00:00:00Z",
      kind: "agent.pause",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "chat-pause", surface: "chat" },
    });
    const resume = createTinyOsAgentTurnControlCommand({
      commandId: "command-resume-1",
      issuedAt: "2026-07-13T00:00:01Z",
      kind: "agent.resume",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "system-bar-resume", surface: "tinyos" },
    });

    expect(pause).toMatchObject({ kind: "agent.pause", target: { turnId: "turn-1" } });
    expect(resume).toMatchObject({ kind: "agent.resume", target: { turnId: "turn-1" } });
  });

  test("creates a correlated form cancellation command", () => {
    expect(createTinyOsFormCancelCommand({
      commandId: "command-form-cancel-1",
      formId: "travel-preferences-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "chat-form", surface: "chat" },
    })).toMatchObject({
      commandId: "command-form-cancel-1",
      form: { formId: "travel-preferences-1" },
      kind: "form.cancel",
    });
  });

  test("creates a retry command with separate source and target turn correlation", () => {
    expect(createTinyOsOperationRetryCommand({
      commandId: "command-retry-1",
      issuedAt: "2026-07-13T00:00:00Z",
      itemId: "turn-failed:error",
      retryTurnId: "turn-retry-1",
      sessionId: "websocket:chat-1",
      source: { control: "operation-shelf", surface: "tinyos" },
      turnId: "turn-failed",
    })).toMatchObject({
      commandId: "command-retry-1",
      kind: "operation.retry",
      operation: { itemId: "turn-failed:error", turnId: "turn-failed" },
      target: { turnId: "turn-retry-1", sessionId: "websocket:chat-1" },
    });
  });

  test("creates a correlated Agent request from bounded file references", () => {
    expect(createTinyOsAgentRequestChangeCommand({
      commandId: "command-request-1",
      instruction: "  Explain this selection.  ",
      issuedAt: "2026-07-13T00:00:00Z",
      observedTurnId: "turn-completed-1",
      references: [{
        detail: "TinyOS file selection",
        kind: "reference",
        sourceEndLine: 3,
        sourceLine: 2,
        sourcePath: "src/main.ts",
        sourceText: "return value;",
        title: "src/main.ts · L2–3",
        type: "tinyos.file",
      }],
      requestTurnId: "turn-request-1",
      sessionId: "websocket:chat-1",
      source: { control: "files-explain-selection", surface: "tinyos" },
    })).toMatchObject({
      commandId: "command-request-1",
      kind: "agent.request_change",
      request: {
        instruction: "Explain this selection.",
        observedTurnId: "turn-completed-1",
        references: [{ sourcePath: "src/main.ts", sourceLine: 2, sourceEndLine: 3 }],
      },
      target: { turnId: "turn-request-1", sessionId: "websocket:chat-1" },
    });
  });

  test("creates confirmed and correlated controlled-host commands", () => {
    const source = { control: "phase-3-test", surface: "tinyos" } as const;
    const save = createTinyOsFileSaveCommand({
      baseRevision: "metadata:12:34",
      commandId: "command-file-save-1",
      content: "updated\n",
      path: "notes/today.md",
      sessionId: "websocket:chat-1",
      source,
    });
    const move = createTinyOsFileMoveCommand({
      baseRevision: "metadata:12:34",
      commandId: "command-file-move-1",
      path: "notes/today.md",
      sessionId: "websocket:chat-1",
      source,
      targetPath: "notes/archive.md",
    });
    const remove = createTinyOsFileDeleteCommand({
      baseRevision: "metadata:12:34",
      commandId: "command-file-delete-1",
      path: "notes/archive.md",
      sessionId: "websocket:chat-1",
      source,
    });
    const execute = createTinyOsTerminalExecuteCommand({
      command: "npm test",
      commandId: "command-terminal-1",
      cwd: "apps/desktop",
      sessionId: "websocket:chat-1",
      source,
    });
    const cancel = createTinyOsTerminalCancelCommand({
      commandId: "command-terminal-cancel-1",
      operationId: execute.target.operationId,
      sessionId: "websocket:chat-1",
      source,
    });
    const browser = createTinyOsBrowserInteractCommand({
      action: { type: "click", x: 12, y: 34 },
      browserSessionId: "browser-session-1",
      captureId: "capture-1",
      controlEpoch: 2,
      commandId: "command-browser-1",
      observationRevision: 4,
      sessionId: "websocket:chat-1",
      source,
      tabId: "tab-1",
    });

    expect(save).toMatchObject({ kind: "file.save", file: { confirmed: true, baseRevision: "metadata:12:34" } });
    expect(move).toMatchObject({ kind: "file.move", file: { targetPath: "notes/archive.md" } });
    expect(remove).toMatchObject({ kind: "file.delete", file: { confirmed: true } });
    expect(execute).toMatchObject({
      kind: "terminal.execute",
      terminal: { command: "npm test", confirmed: true, cwd: "apps/desktop" },
    });
    expect(cancel).toMatchObject({ kind: "terminal.cancel", target: { operationId: execute.target.operationId } });
    expect(browser).toMatchObject({
      kind: "browser.interact",
      browser: {
        browserSessionId: "browser-session-1",
        captureId: "capture-1",
        confirmed: true,
        tabId: "tab-1",
        action: { type: "click", x: 12, y: 34 },
      },
    });
  });

  test("rejects an existing-file save without a base revision", () => {
    expect(() => createTinyOsFileSaveCommand({
      content: "updated\n",
      path: "notes/today.md",
      sessionId: "websocket:chat-1",
      source: { control: "phase-3-test", surface: "tinyos" },
    })).toThrow("Existing file saves require a base revision.");
  });

  test("keeps a command pending after transport acceptance until canonical acknowledgement", () => {
    let state: TinyOsCommandLifecycle = { stage: "idle" };
    state = reduceTinyOsCommandLifecycle(state, { command, nowMs: 10, type: "dispatch" });
    expect(isTinyOsCommandPending(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, { commandId: "command-1", nowMs: 20, type: "transport_accepted" });
    expect(state.stage).toBe("waiting_for_canonical");
    expect(isTinyOsCommandPending(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, {
      acknowledgement: { itemId: "turn-1:command-ack:command-1", revision: 1 },
      commandId: "command-1",
      nowMs: 30,
      type: "canonical_acknowledged",
    });
    expect(state).toMatchObject({
      acknowledgement: { itemId: "turn-1:command-ack:command-1", revision: 1 },
      stage: "acknowledged",
    });
    expect(isTinyOsCommandPending(state)).toBe(false);
    expect(isTinyOsCommandInFlight(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, {
      commandId: "command-1",
      completion: { itemId: "turn-1:error:cancelled", revision: 7, status: "cancelled" },
      nowMs: 40,
      type: "operation_completed",
    });
    expect(state).toMatchObject({ completion: { status: "cancelled" }, stage: "completed" });
    expect(isTinyOsCommandInFlight(state)).toBe(false);
  });

  test("acknowledges approval delivery as soon as the backend accepts the decision", () => {
    const approvalCommand = createTinyOsApprovalResolveCommand({
      action: "approveOnce",
      approvalId: "approval-1",
      commandId: "command-approval-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "inspector-approval", surface: "tinyos" },
    });
    let state: TinyOsCommandLifecycle = { stage: "idle" };
    state = reduceTinyOsCommandLifecycle(state, { command: approvalCommand, nowMs: 10, type: "dispatch" });
    state = reduceTinyOsCommandLifecycle(state, {
      commandId: approvalCommand.commandId,
      nowMs: 20,
      type: "transport_accepted",
    });

    expect(state).toMatchObject({
      acknowledgement: { itemId: "approval-1", revision: 0 },
      stage: "acknowledged",
    });
    expect(isTinyOsCommandPending(state)).toBe(false);
    expect(isTinyOsCommandInFlight(state)).toBe(false);
  });

  test("ignores acknowledgements for a different correlation id", () => {
    const state = reduceTinyOsCommandLifecycle(
      { command, dispatchedAtMs: 10, stage: "sending" },
      {
        acknowledgement: { itemId: "other", revision: 1 },
        commandId: "command-other",
        nowMs: 20,
        type: "canonical_acknowledged",
      },
    );
    expect(state.stage).toBe("sending");
  });

  test("keeps rejection and missing acknowledgement visible", () => {
    const rejected = reduceTinyOsCommandLifecycle(
      { command, dispatchedAtMs: 10, stage: "sending" },
      { commandId: "command-1", error: "run is not active", type: "rejected" },
    );
    expect(rejected).toMatchObject({ error: "run is not active", stage: "rejected" });

    const timedOut = reduceTinyOsCommandLifecycle(
      { command, dispatchedAtMs: 10, stage: "sending" },
      { commandId: "command-1", type: "ack_timeout" },
    );
    expect(timedOut).toMatchObject({ stage: "timed_out" });

    const rejectedAfterAcknowledgement = reduceTinyOsCommandLifecycle(
      {
        acknowledgement: { itemId: "ack-1", revision: 1 },
        acknowledgedAtMs: 20,
        command,
        dispatchedAtMs: 10,
        stage: "acknowledged",
      },
      { commandId: "command-1", error: "continuation failed", type: "rejected" },
    );
    expect(rejectedAfterAcknowledgement).toMatchObject({ error: "continuation failed", stage: "rejected" });
  });

  test("distinguishes canonical acknowledgement from operation completion", () => {
    const turn = {
      canonicalItems: [{
        createdAt: "2026-07-13T00:00:00Z",
        data: {
          detail: { commandId: "command-1", commandStatus: "acknowledged" },
          message: "Agent command acknowledged",
          type: "system_notice",
        },
        itemId: "turn-1:command-ack:command-1",
        kind: "system_notice",
        revision: 1,
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 5,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "turn-1",
      }, {
        createdAt: "2026-07-13T00:00:01Z",
        data: { cancelled: true, code: "cancelled", commandId: "command-1", message: "cancelled", type: "error" },
        itemId: "turn-1:error:cancelled",
        kind: "error",
        revision: 7,
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "cancelled",
        turnId: "turn-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandAcknowledgement([turn], "command-1")).toEqual({
      itemId: "turn-1:command-ack:command-1",
      revision: 1,
    });
    expect(canonicalTinyOsCommandCompletion([turn], "command-1")).toEqual({
      itemId: "turn-1:error:cancelled",
      revision: 7,
      status: "cancelled",
    });
    expect(canonicalTinyOsCommandAcknowledgement([turn], "command-other")).toBeUndefined();
  });

  test("recognizes a correlated approval decision as command completion", () => {
    const turn = {
      canonicalItems: [{
        createdAt: "2026-07-13T00:00:01Z",
        data: {
          approvalId: "approval-1",
          commandId: "command-approval-1",
          decision: "approved",
          status: "completed",
          type: "approval",
        },
        itemId: "turn-1:approval:approval-1",
        kind: "approval",
        revision: 2,
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "turn-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandAcknowledgement([turn], "command-approval-1")).toEqual({
      itemId: "turn-1:approval:approval-1",
      revision: 2,
    });
    expect(canonicalTinyOsCommandCompletion([turn], "command-approval-1")).toEqual({
      itemId: "turn-1:approval:approval-1",
      revision: 2,
      status: "completed",
    });
  });

  test("recognizes a correlated form resolution as command completion", () => {
    const turn = {
      canonicalItems: [{
        createdAt: "2026-07-13T00:00:01Z",
        data: {
          action: "submit",
          commandId: "command-form-1",
          fieldIds: ["destination"],
          formId: "travel-preferences-1",
          status: "completed",
          type: "form",
          values: { destination: "Singapore" },
        },
        itemId: "turn-1:form:travel-preferences-1",
        kind: "form",
        revision: 2,
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "turn-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandCompletion([turn], "command-form-1")).toEqual({
      itemId: "turn-1:form:travel-preferences-1",
      revision: 2,
      status: "completed",
    });
  });

  test("recognizes correlated safe-boundary pause and resume events", () => {
    const pause = createTinyOsAgentTurnControlCommand({
      commandId: "command-pause-1",
      kind: "agent.pause",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "chat-pause", surface: "chat" },
    });
    const resume = createTinyOsAgentTurnControlCommand({
      commandId: "command-resume-1",
      kind: "agent.resume",
      turnId: "turn-1",
      sessionId: "websocket:chat-1",
      source: { control: "chat-resume", surface: "chat" },
    });
    const turn = {
      id: "turn-1",
      canonicalItems: [{
        data: { detail: { commandId: "command-pause-1", message: "Agent turn paused" }, type: "system_notice" },
        itemId: "turn-1:agent-paused",
        kind: "system_notice",
        revision: 2,
        status: "completed",
      }, {
        data: { detail: { commandId: "command-resume-1", message: "Agent turn resumed" }, type: "system_notice" },
        itemId: "turn-1:agent-resumed",
        kind: "system_notice",
        revision: 3,
        status: "completed",
      }],
    } as unknown as ChatTurn;

    expect(canonicalTinyOsCommandCompletion([turn], pause)).toMatchObject({ itemId: "turn-1:agent-paused", status: "completed" });
    expect(canonicalTinyOsCommandCompletion([turn], resume)).toMatchObject({ itemId: "turn-1:agent-resumed", status: "completed" });
  });

  test("recognizes the terminal item of the explicit retry turn as completion", () => {
    const retry = createTinyOsOperationRetryCommand({
      commandId: "command-retry-1",
      itemId: "turn-failed:error",
      retryTurnId: "turn-retry-1",
      sessionId: "websocket:chat-1",
      source: { control: "error-recovery", surface: "chat" },
      turnId: "turn-failed",
    });
    const turn = {
      id: "turn-retry-1",
      status: "completed",
      canonicalItems: [{
        data: { content: "Recovered", type: "message" },
        itemId: "turn-retry-1:assistant",
        revision: 3,
        status: "completed",
      }],
    } as unknown as ChatTurn;

    expect(canonicalTinyOsCommandCompletion([turn], retry)).toEqual({
      itemId: "turn-retry-1:assistant",
      revision: 3,
      status: "completed",
    });
  });

  test("recognizes the terminal item of an Agent request turn as completion", () => {
    const request = createTinyOsAgentRequestChangeCommand({
      commandId: "command-request-1",
      instruction: "Explain this selection.",
      references: [{
        detail: "TinyOS file selection",
        kind: "reference",
        sourceEndLine: 1,
        sourceLine: 1,
        sourcePath: "README.md",
        sourceText: "# Tinybot",
        title: "README.md · L1",
        type: "tinyos.file",
      }],
      requestTurnId: "turn-request-1",
      sessionId: "websocket:chat-1",
      source: { control: "files-explain-selection", surface: "tinyos" },
    });
    const turn = {
      id: "turn-request-1",
      status: "completed",
      canonicalItems: [{
        data: { content: "This is the project heading.", type: "message" },
        itemId: "turn-request-1:assistant",
        revision: 3,
        status: "completed",
      }],
    } as unknown as ChatTurn;

    expect(canonicalTinyOsCommandCompletion([turn], request)).toEqual({
      itemId: "turn-request-1:assistant",
      revision: 3,
      status: "completed",
    });
  });
});
