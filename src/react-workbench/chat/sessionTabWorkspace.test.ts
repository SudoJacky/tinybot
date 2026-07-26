import { describe, expect, it } from "vitest";
import {
  DRAFT_SESSION_KEY,
  INITIAL_SESSION_TAB_WORKSPACE,
  reduceSessionTabWorkspace,
  sessionTabDraft,
} from "./sessionTabWorkspace";

describe("sessionTabWorkspace", () => {
  it("hydrates only available tabs and falls back to the first session", () => {
    const state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1", "s2"],
      persisted: {
        activeSessionId: "missing",
        draftsBySession: { missing: "drop", s2: "keep", [DRAFT_SESSION_KEY]: "new" },
        openSessionIds: ["missing", "s2"],
      },
    });

    expect(state).toEqual({
      activeSessionId: "s2",
      draftsBySession: { s2: "keep", [DRAFT_SESSION_KEY]: "new" },
      openSessionIds: ["s2"],
      unreadSessionIds: [],
    });
  });

  it("preserves an intentionally empty saved tab set", () => {
    const state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1", "s2"],
      persisted: {
        activeSessionId: "",
        draftsBySession: { [DRAFT_SESSION_KEY]: "new" },
        openSessionIds: [],
      },
    });

    expect(state.activeSessionId).toBe("");
    expect(state.openSessionIds).toEqual([]);
    expect(sessionTabDraft(state, "")).toBe("new");
  });

  it("opens, activates, and closes tabs without deleting their drafts", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1", "s2", "s3"],
    });
    state = reduceSessionTabWorkspace(state, { type: "draft.changed", sessionId: "s1", value: "draft one" });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s2" });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s3" });
    state = reduceSessionTabWorkspace(state, { type: "activate", sessionId: "s2" });
    state = reduceSessionTabWorkspace(state, { type: "close", sessionId: "s2" });

    expect(state.openSessionIds).toEqual(["s1", "s3"]);
    expect(state.activeSessionId).toBe("s3");
    expect(sessionTabDraft(state, "s1")).toBe("draft one");
  });

  it("removes deleted sessions and their saved view state", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1", "s2"],
    });
    state = reduceSessionTabWorkspace(state, { type: "draft.changed", sessionId: "s1", value: "discard me" });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s2" });
    state = reduceSessionTabWorkspace(state, { type: "remove", sessionId: "s1" });

    expect(state.openSessionIds).toEqual(["s2"]);
    expect(state.draftsBySession.s1).toBeUndefined();
  });

  it("marks only inactive open tabs unread and clears unread on activation", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1", "s2"],
    });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s2" });
    state = reduceSessionTabWorkspace(state, { type: "activity", sessionId: "s1" });
    state = reduceSessionTabWorkspace(state, { type: "activity", sessionId: "s2" });

    expect(state.unreadSessionIds).toEqual(["s1"]);

    state = reduceSessionTabWorkspace(state, { type: "activate", sessionId: "s1" });
    expect(state.unreadSessionIds).toEqual([]);
  });

  it("moves the active tab and draft when a pending session receives its canonical id", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "open",
      sessionId: "pending:1",
    });
    state = reduceSessionTabWorkspace(state, {
      type: "draft.changed",
      sessionId: "pending:1",
      value: "keep this",
    });
    state = reduceSessionTabWorkspace(state, {
      type: "replace",
      previousSessionId: "pending:1",
      sessionId: "WebSocket:chat-2",
    });

    expect(state.activeSessionId).toBe("WebSocket:chat-2");
    expect(state.openSessionIds).toEqual(["WebSocket:chat-2"]);
    expect(sessionTabDraft(state, "WebSocket:chat-2")).toBe("keep this");
  });
});
