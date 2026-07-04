import { describe, expect, it } from "vitest";
import { reduceSessionDeleteState } from "./sessionDeleteState";

describe("reduceSessionDeleteState", () => {
  it("requires a second delete click before confirming deletion", () => {
    const first = reduceSessionDeleteState({ confirmingSessionId: "" }, { type: "delete-clicked", sessionId: "s1" });
    expect(first).toEqual({ confirmingSessionId: "s1", confirmedSessionId: "" });

    const second = reduceSessionDeleteState(first, { type: "delete-clicked", sessionId: "s1" });
    expect(second).toEqual({ confirmingSessionId: "", confirmedSessionId: "s1" });
  });

  it("clears confirmation when the row loses hover or another session is selected", () => {
    const confirming = { confirmingSessionId: "s1" };
    expect(reduceSessionDeleteState(confirming, { type: "row-left", sessionId: "s1" })).toEqual({
      confirmingSessionId: "",
      confirmedSessionId: "",
    });
    expect(reduceSessionDeleteState(confirming, { type: "session-selected", sessionId: "s2" })).toEqual({
      confirmingSessionId: "",
      confirmedSessionId: "",
    });
  });
});
