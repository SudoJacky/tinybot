import { describe, expect, test } from "vitest";
import type { ChatTurn } from "./chatTurnContracts";
import {
  canonicalThreadCommandAcknowledgement,
  canonicalThreadCommandCompletion,
  createThreadAgentCancelCommand,
  createThreadFormCancelCommand,
  createThreadFormSubmitCommand,
  createThreadOperationRetryCommand,
  isThreadCommandInFlight,
  isThreadCommandPending,
  reduceThreadCommandLifecycle,
  type ThreadCommandLifecycle,
} from "./threadCommand";

const command = createThreadAgentCancelCommand({
  commandId: "command-1",
  issuedAt: "2026-07-13T00:00:00Z",
  turnId: "turn-1",
  sessionId: "thread-1",
  source: { control: "stop-response", surface: "chat" },
});

describe("chat runtime command lifecycle", () => {
  test("creates correlated form commands", () => {
    expect(createThreadFormSubmitCommand({
      commandId: "command-form-1",
      formId: "travel-preferences-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "thread-1",
      source: { control: "chat-form", surface: "chat" },
      values: { destination: "Singapore", nights: 4 },
    })).toMatchObject({
      commandId: "command-form-1",
      form: {
        formId: "travel-preferences-1",
        values: { destination: "Singapore", nights: 4 },
      },
      kind: "form.submit",
    });

    expect(createThreadFormCancelCommand({
      commandId: "command-form-cancel-1",
      formId: "travel-preferences-1",
      issuedAt: "2026-07-13T00:00:00Z",
      turnId: "turn-1",
      sessionId: "thread-1",
      source: { control: "chat-form", surface: "chat" },
    })).toMatchObject({
      commandId: "command-form-cancel-1",
      form: { formId: "travel-preferences-1" },
      kind: "form.cancel",
    });
  });

  test("creates a retry command with separate source and target turn correlation", () => {
    const retry = createThreadOperationRetryCommand({
      commandId: "command-retry-1",
      issuedAt: "2026-07-13T00:00:00Z",
      itemId: "turn-failed:error",
      retryTurnId: "turn-retry-1",
      sessionId: "thread-1",
      source: { control: "error-recovery", surface: "chat" },
      turnId: "turn-failed",
    });

    expect(retry).toMatchObject({
      commandId: "command-retry-1",
      kind: "operation.retry",
      operation: { itemId: "turn-failed:error", turnId: "turn-failed" },
      target: { sessionId: "thread-1", turnId: "turn-retry-1" },
    });
  });

  test("waits for canonical acknowledgement and completion", () => {
    let state: ThreadCommandLifecycle = { stage: "idle" };
    state = reduceThreadCommandLifecycle(state, { command, nowMs: 10, type: "dispatch" });
    expect(isThreadCommandPending(state)).toBe(true);

    state = reduceThreadCommandLifecycle(state, {
      commandId: "command-1",
      nowMs: 20,
      type: "transport_accepted",
    });
    expect(state.stage).toBe("waiting_for_canonical");

    state = reduceThreadCommandLifecycle(state, {
      acknowledgement: { itemId: "turn-1:command-ack:command-1", revision: 1 },
      commandId: "command-1",
      nowMs: 30,
      type: "canonical_acknowledged",
    });
    expect(state.stage).toBe("acknowledged");
    expect(isThreadCommandPending(state)).toBe(false);
    expect(isThreadCommandInFlight(state)).toBe(true);

    state = reduceThreadCommandLifecycle(state, {
      commandId: "command-1",
      completion: { itemId: "turn-1:error:cancelled", revision: 7, status: "cancelled" },
      nowMs: 40,
      type: "operation_completed",
    });
    expect(state).toMatchObject({ completion: { status: "cancelled" }, stage: "completed" });
    expect(isThreadCommandInFlight(state)).toBe(false);
  });

  test("keeps rejection and timeout failures visible", () => {
    const sending: ThreadCommandLifecycle = { command, dispatchedAtMs: 10, stage: "sending" };
    expect(reduceThreadCommandLifecycle(sending, {
      commandId: "command-1",
      error: "turn is not active",
      type: "rejected",
    })).toMatchObject({ error: "turn is not active", stage: "rejected" });
    expect(reduceThreadCommandLifecycle(sending, {
      commandId: "command-1",
      type: "ack_timeout",
    })).toMatchObject({ stage: "timed_out" });
  });

  test("distinguishes acknowledgement from command completion", () => {
    const turn = {
      canonicalItems: [{
        data: { detail: { commandId: "command-1", commandStatus: "acknowledged" } },
        itemId: "turn-1:command-ack:command-1",
        revision: 1,
        status: "completed",
      }, {
        data: { commandId: "command-1" },
        itemId: "turn-1:error:cancelled",
        revision: 7,
        status: "cancelled",
      }],
    } as unknown as ChatTurn;

    expect(canonicalThreadCommandAcknowledgement([turn], "command-1")).toEqual({
      itemId: "turn-1:command-ack:command-1",
      revision: 1,
    });
    expect(canonicalThreadCommandCompletion([turn], "command-1")).toEqual({
      itemId: "turn-1:error:cancelled",
      revision: 7,
      status: "cancelled",
    });
  });

  test("recognizes the terminal item of the explicit retry turn", () => {
    const retry = createThreadOperationRetryCommand({
      commandId: "command-retry-1",
      itemId: "turn-failed:error",
      retryTurnId: "turn-retry-1",
      sessionId: "thread-1",
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

    expect(canonicalThreadCommandCompletion([turn], retry)).toEqual({
      itemId: "turn-retry-1:assistant",
      revision: 3,
      status: "completed",
    });
  });
});
