import { describe, expect, test } from "vitest";
import type { ChatTurn } from "./chatRunModel";
import {
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
  createTinyOsApprovalResolveCommand,
  createTinyOsFormCancelCommand,
  createTinyOsFormSubmitCommand,
  isTinyOsCommandInFlight,
  isTinyOsCommandPending,
  reduceTinyOsCommandLifecycle,
  type TinyOsCommandLifecycle,
} from "./tinyOsCommandGateway";

const command = createTinyOsAgentCancelCommand({
  commandId: "command-1",
  issuedAt: "2026-07-13T00:00:00Z",
  runId: "run-1",
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
      runId: "run-1",
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
      runId: "run-1",
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

  test("creates a correlated form cancellation command", () => {
    expect(createTinyOsFormCancelCommand({
      commandId: "command-form-cancel-1",
      formId: "travel-preferences-1",
      issuedAt: "2026-07-13T00:00:00Z",
      runId: "run-1",
      sessionId: "websocket:chat-1",
      source: { control: "chat-form", surface: "chat" },
    })).toMatchObject({
      commandId: "command-form-cancel-1",
      form: { formId: "travel-preferences-1" },
      kind: "form.cancel",
    });
  });

  test("keeps a command pending after transport acceptance until canonical acknowledgement", () => {
    let state: TinyOsCommandLifecycle = { stage: "idle" };
    state = reduceTinyOsCommandLifecycle(state, { command, nowMs: 10, type: "dispatch" });
    expect(isTinyOsCommandPending(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, { commandId: "command-1", nowMs: 20, type: "transport_accepted" });
    expect(state.stage).toBe("waiting_for_canonical");
    expect(isTinyOsCommandPending(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, {
      acknowledgement: { itemId: "run-1:command-ack:command-1", revision: 1 },
      commandId: "command-1",
      nowMs: 30,
      type: "canonical_acknowledged",
    });
    expect(state).toMatchObject({
      acknowledgement: { itemId: "run-1:command-ack:command-1", revision: 1 },
      stage: "acknowledged",
    });
    expect(isTinyOsCommandPending(state)).toBe(false);
    expect(isTinyOsCommandInFlight(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, {
      commandId: "command-1",
      completion: { itemId: "run-1:error:cancelled", revision: 7, status: "cancelled" },
      nowMs: 40,
      type: "operation_completed",
    });
    expect(state).toMatchObject({ completion: { status: "cancelled" }, stage: "completed" });
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
        itemId: "run-1:command-ack:command-1",
        kind: "system_notice",
        revision: 1,
        runId: "run-1",
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 5,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "run-1",
      }, {
        createdAt: "2026-07-13T00:00:01Z",
        data: { cancelled: true, code: "cancelled", commandId: "command-1", message: "cancelled", type: "error" },
        itemId: "run-1:error:cancelled",
        kind: "error",
        revision: 7,
        runId: "run-1",
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "cancelled",
        turnId: "run-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandAcknowledgement([turn], "command-1")).toEqual({
      itemId: "run-1:command-ack:command-1",
      revision: 1,
    });
    expect(canonicalTinyOsCommandCompletion([turn], "command-1")).toEqual({
      itemId: "run-1:error:cancelled",
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
        itemId: "run-1:approval:approval-1",
        kind: "approval",
        revision: 2,
        runId: "run-1",
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "run-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandCompletion([turn], "command-approval-1")).toEqual({
      itemId: "run-1:approval:approval-1",
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
        itemId: "run-1:form:travel-preferences-1",
        kind: "form",
        revision: 2,
        runId: "run-1",
        schemaVersion: "tinybot.turn_item.v2",
        sequence: 6,
        sessionId: "websocket:chat-1",
        status: "completed",
        turnId: "run-1",
      }],
    } as unknown as ChatTurn;
    expect(canonicalTinyOsCommandCompletion([turn], "command-form-1")).toEqual({
      itemId: "run-1:form:travel-preferences-1",
      revision: 2,
      status: "completed",
    });
  });
});
