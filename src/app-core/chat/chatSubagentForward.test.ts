import { describe, expect, test } from "vitest";

import type { LiveSubagent } from "./chatUiProjection";
import {
  createSubagentForwardBlock,
  reconcileSubagentSyncState,
  requiresForwardApprovalGuidanceConfirmation,
} from "./chatSubagentForward";

describe("chatSubagentForward", () => {
  test("creates a removable main-composer draft block without auto execution", () => {
    const block = createSubagentForwardBlock(fixtureSubagent(), ["m-2", "m-3"]);

    expect(block.sourceSubagentId).toBe("delegate-1");
    expect(block.sourceSubagentName).toBe("Researcher");
    expect(block.removable).toBe(true);
    expect(block.autoSend).toBe(false);
    expect(block.messages).toEqual([
      { id: "m-2", role: "assistant", content: "Found option A." },
      { id: "m-3", role: "user", content: "Prefer lower risk." },
    ]);
    expect(block.fallbackText).toContain("Researcher");
    expect(block.fallbackText).toContain("assistant: Found option A.");
    expect(block.fallbackText).toContain("user: Prefer lower risk.");
  });

  test("requires explicit confirmation when forwarding while approval guidance is active", () => {
    expect(requiresForwardApprovalGuidanceConfirmation("approval_guidance")).toBe(true);
    expect(requiresForwardApprovalGuidanceConfirmation("normal")).toBe(false);
  });

  test("clears unsynced intervention only after backend synchronization observes the revision", () => {
    const current = fixtureSubagent({ status: "user_intervened_unsynced" });

    expect(reconcileSubagentSyncState(current, { observedRevision: "r1" }).status).toBe("user_intervened_unsynced");
    expect(reconcileSubagentSyncState(current, {
      observedRevision: "r2",
      postInterventionRevision: "r2",
    }).status).toBe("has_update");
  });
});

function fixtureSubagent(overrides: Partial<LiveSubagent> = {}): LiveSubagent {
  return {
    id: "delegate-1",
    sessionKey: "websocket:chat-1",
    name: "Researcher",
    task: "Research options",
    status: "has_update",
    latestActivity: "New output",
    capabilities: ["full_transcript", "can_forward"],
    transcript: {
      id: "delegate-1",
      sessionKey: "websocket:chat-1",
      capability: "full_transcript",
      messages: [
        { id: "m-1", role: "system", content: "Private setup." },
        { id: "m-2", role: "assistant", content: "Found option A." },
        { id: "m-3", role: "user", content: "Prefer lower risk." },
      ],
      toolSummaries: [],
    },
    ...overrides,
  };
}
