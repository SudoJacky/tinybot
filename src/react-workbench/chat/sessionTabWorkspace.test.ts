import { describe, expect, it } from "vitest";
import {
  DRAFT_SESSION_KEY,
  INITIAL_SESSION_TAB_WORKSPACE,
  persistedSessionTabWorkspace,
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
      draftSessionsById: {},
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

  it("keeps a startup draft active when session hydration completes", () => {
    const drafting = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "draft.changed",
      sessionId: "",
      value: "Draft while loading",
    });
    const state = reduceSessionTabWorkspace(drafting, {
      type: "hydrate",
      availableSessionIds: ["s1"],
    });

    expect(state.activeSessionId).toBe("");
    expect(state.openSessionIds).toEqual(["s1"]);
    expect(sessionTabDraft(state, "")).toBe("Draft while loading");
  });

  it("materializes startup text as a navigable local draft", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "draft.changed",
      sessionId: "",
      value: "Keep the startup draft",
    });
    state = reduceSessionTabWorkspace(state, {
      type: "startup-draft.materialize",
      draft: {
        id: "draft:startup",
        createdAtMs: 10,
        createInput: {},
      },
    });

    expect(state.activeSessionId).toBe("draft:startup");
    expect(state.openSessionIds).toEqual(["draft:startup"]);
    expect(state.draftSessionsById["draft:startup"]?.createInput).toEqual({});
    expect(sessionTabDraft(state, "draft:startup")).toBe("Keep the startup draft");
    expect(state.draftsBySession[DRAFT_SESSION_KEY]).toBeUndefined();
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

  it("discards a pristine local session draft when another session is opened", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1"],
    });
    state = reduceSessionTabWorkspace(state, {
      type: "session-draft.open",
      draft: {
        id: "draft:1",
        createdAtMs: 10,
        createInput: { workingDirectory: "D:\\Code\\tinybot" },
      },
    });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s1" });

    expect(state.activeSessionId).toBe("s1");
    expect(state.openSessionIds).toEqual(["s1"]);
    expect(state.draftSessionsById).toEqual({});
  });

  it("keeps a non-empty local session draft when another session is opened", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1"],
    });
    state = reduceSessionTabWorkspace(state, {
      type: "session-draft.open",
      draft: {
        id: "draft:1",
        createdAtMs: 10,
        createInput: { projectGroupId: "group-1", workingDirectory: "D:\\Code\\tinybot" },
      },
    });
    state = reduceSessionTabWorkspace(state, {
      type: "draft.changed",
      sessionId: "draft:1",
      value: "Keep this locally",
    });
    state = reduceSessionTabWorkspace(state, { type: "open", sessionId: "s1" });

    expect(state.activeSessionId).toBe("s1");
    expect(state.openSessionIds).toEqual(["s1", "draft:1"]);
    expect(state.draftSessionsById["draft:1"]?.createInput).toEqual({
      projectGroupId: "group-1",
      workingDirectory: "D:\\Code\\tinybot",
    });
    expect(sessionTabDraft(state, "draft:1")).toBe("Keep this locally");
  });

  it("replaces a local session draft with the created Thread without losing composer text", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "session-draft.open",
      draft: {
        id: "draft:1",
        createdAtMs: 10,
        createInput: { workingDirectory: "D:\\Code\\tinybot" },
      },
    });
    state = reduceSessionTabWorkspace(state, {
      type: "draft.changed",
      sessionId: "draft:1",
      value: "Create me",
    });
    state = reduceSessionTabWorkspace(state, {
      type: "replace",
      previousSessionId: "draft:1",
      sessionId: "thread:1",
    });

    expect(state.activeSessionId).toBe("thread:1");
    expect(state.openSessionIds).toEqual(["thread:1"]);
    expect(state.draftSessionsById).toEqual({});
    expect(sessionTabDraft(state, "thread:1")).toBe("Create me");
  });

  it("persists only local session drafts that contain composer text", () => {
    let state = reduceSessionTabWorkspace(INITIAL_SESSION_TAB_WORKSPACE, {
      type: "hydrate",
      availableSessionIds: ["s1"],
    });
    state = reduceSessionTabWorkspace(state, {
      type: "session-draft.open",
      draft: { id: "draft:dirty", createdAtMs: 10, createInput: { workingDirectory: "D:\\Code\\one" } },
    });
    state = reduceSessionTabWorkspace(state, {
      type: "draft.changed",
      sessionId: "draft:dirty",
      value: "Keep me",
    });
    state = reduceSessionTabWorkspace(state, {
      type: "session-draft.open",
      draft: { id: "draft:pristine", createdAtMs: 20, createInput: { workingDirectory: "D:\\Code\\two" } },
    });

    expect(persistedSessionTabWorkspace(state)).toEqual({
      activeSessionId: "s1",
      draftSessionsById: {
        "draft:dirty": {
          id: "draft:dirty",
          createdAtMs: 10,
          createInput: { workingDirectory: "D:\\Code\\one" },
        },
      },
      draftsBySession: { "draft:dirty": "Keep me" },
      openSessionIds: ["s1", "draft:dirty"],
    });
  });
});
