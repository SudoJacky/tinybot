import { describe, expect, test } from "vitest";
import type { ChatTurn } from "./chatRunModel";
import {
  canonicalTinyOsCommandAcknowledgement,
  canonicalTinyOsCommandCompletion,
  createTinyOsAgentCancelCommand,
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
    } as ChatTurn;
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
});
