import { describe, expect, test } from "vitest";
import type { ChatTurn } from "./chatTurnContracts";
import {
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
  createTinyOsFormCancelCommand,
  createTinyOsFormSubmitCommand,
  createTinyOsOperationRetryCommand,
  isTinyOsCommandInFlight,
  isTinyOsCommandPending,
  reduceTinyOsCommandLifecycle,
  toNativeTinyOsHostCommandFrame,
  type TinyOsCommandLifecycle,
} from "./tinyOsCommand";

const command = createTinyOsAgentCancelCommand({
  commandId: "command-1",
  issuedAt: "2026-07-13T00:00:00Z",
  turnId: "turn-1",
  sessionId: "thread-1",
  source: { control: "stop-response", surface: "chat" },
});

describe("chat runtime command lifecycle", () => {
  test("creates correlated form commands", () => {
    expect(createTinyOsFormSubmitCommand({
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

    expect(createTinyOsFormCancelCommand({
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

  test("creates a retry frame with separate source and target turn correlation", () => {
    const retry = createTinyOsOperationRetryCommand({
      commandId: "command-retry-1",
      issuedAt: "2026-07-13T00:00:00Z",
      itemId: "turn-failed:error",
      retryTurnId: "turn-retry-1",
      sessionId: "thread-1",
      source: { control: "error-recovery", surface: "chat" },
      turnId: "turn-failed",
    });

    expect(toNativeTinyOsHostCommandFrame("thread-1", retry)).toMatchObject({
      chat_id: "thread-1",
      command_id: "command-retry-1",
      command_kind: "operation.retry",
      item_id: "turn-failed:error",
      source_turn_id: "turn-failed",
      turn_id: "turn-retry-1",
    });
  });

  test("waits for canonical acknowledgement and completion", () => {
    let state: TinyOsCommandLifecycle = { stage: "idle" };
    state = reduceTinyOsCommandLifecycle(state, { command, nowMs: 10, type: "dispatch" });
    expect(isTinyOsCommandPending(state)).toBe(true);

    state = reduceTinyOsCommandLifecycle(state, {
      commandId: "command-1",
      nowMs: 20,
      type: "transport_accepted",
    });
    expect(state.stage).toBe("waiting_for_canonical");

    state = reduceTinyOsCommandLifecycle(state, {
      acknowledgement: { itemId: "turn-1:command-ack:command-1", revision: 1 },
      commandId: "command-1",
      nowMs: 30,
      type: "canonical_acknowledged",
    });
    expect(state.stage).toBe("acknowledged");
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

  test("keeps rejection and timeout failures visible", () => {
    const sending: TinyOsCommandLifecycle = { command, dispatchedAtMs: 10, stage: "sending" };
    expect(reduceTinyOsCommandLifecycle(sending, {
      commandId: "command-1",
      error: "turn is not active",
      type: "rejected",
    })).toMatchObject({ error: "turn is not active", stage: "rejected" });
    expect(reduceTinyOsCommandLifecycle(sending, {
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

    expect(canonicalTinyOsCommandAcknowledgement([turn], "command-1")).toEqual({
      itemId: "turn-1:command-ack:command-1",
      revision: 1,
    });
    expect(canonicalTinyOsCommandCompletion([turn], "command-1")).toEqual({
      itemId: "turn-1:error:cancelled",
      revision: 7,
      status: "cancelled",
    });
  });

  test("recognizes the terminal item of the explicit retry turn", () => {
    const retry = createTinyOsOperationRetryCommand({
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

    expect(canonicalTinyOsCommandCompletion([turn], retry)).toEqual({
      itemId: "turn-retry-1:assistant",
      revision: 3,
      status: "completed",
    });
  });
});
