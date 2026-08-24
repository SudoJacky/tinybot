export const CHAT_SESSION_TABS_STORAGE_KEY = "tinybot.ui.chat.session-tabs.v1";
export const DRAFT_SESSION_KEY = "__tinybot_draft_session__";

export type SessionTabWorkspaceState = {
  activeSessionId: string;
  draftsBySession: Record<string, string>;
  openSessionIds: string[];
  unreadSessionIds: string[];
};

export type PersistedSessionTabWorkspace = Pick<
  SessionTabWorkspaceState,
  "activeSessionId" | "draftsBySession" | "openSessionIds"
>;

export type SessionTabWorkspaceEvent =
  | { type: "hydrate"; availableSessionIds: string[]; persisted?: PersistedSessionTabWorkspace }
  | { type: "open"; sessionId: string }
  | { type: "activate"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "remove"; sessionId: string }
  | { type: "activity"; sessionId: string }
  | { type: "draft.changed"; sessionId: string; value: string }
  | { type: "replace"; previousSessionId: string; sessionId: string }
  | { type: "reconcile"; availableSessionIds: string[] };

export const INITIAL_SESSION_TAB_WORKSPACE: SessionTabWorkspaceState = {
  activeSessionId: "",
  draftsBySession: {},
  openSessionIds: [],
  unreadSessionIds: [],
};

export function reduceSessionTabWorkspace(
  state: SessionTabWorkspaceState,
  event: SessionTabWorkspaceEvent,
): SessionTabWorkspaceState {
  switch (event.type) {
    case "hydrate": {
      const hydrated = hydrateWorkspace(event.availableSessionIds, event.persisted);
      const startupDraft = state.draftsBySession[DRAFT_SESSION_KEY];
      if (!startupDraft) {
        return hydrated;
      }
      return {
        ...hydrated,
        activeSessionId: "",
        draftsBySession: {
          ...hydrated.draftsBySession,
          [DRAFT_SESSION_KEY]: startupDraft,
        },
      };
    }
    case "open":
    case "activate": {
      const openSessionIds = state.openSessionIds.includes(event.sessionId)
        ? state.openSessionIds
        : [...state.openSessionIds, event.sessionId];
      return {
        ...state,
        activeSessionId: event.sessionId,
        openSessionIds,
        unreadSessionIds: withoutValue(state.unreadSessionIds, event.sessionId),
      };
    }
    case "close": {
      const index = state.openSessionIds.indexOf(event.sessionId);
      if (index < 0) {
        return state;
      }
      const openSessionIds = withoutValue(state.openSessionIds, event.sessionId);
      const activeSessionId = state.activeSessionId === event.sessionId
        ? openSessionIds[index] ?? openSessionIds[index - 1] ?? ""
        : state.activeSessionId;
      return {
        ...state,
        activeSessionId,
        openSessionIds,
        unreadSessionIds: withoutValue(state.unreadSessionIds, event.sessionId),
      };
    }
    case "remove": {
      const closed = reduceSessionTabWorkspace(state, { type: "close", sessionId: event.sessionId });
      const draftsBySession = { ...closed.draftsBySession };
      delete draftsBySession[event.sessionId];
      return { ...closed, draftsBySession };
    }
    case "activity":
      if (event.sessionId === state.activeSessionId
        || !state.openSessionIds.includes(event.sessionId)
        || state.unreadSessionIds.includes(event.sessionId)) {
        return state;
      }
      return { ...state, unreadSessionIds: [...state.unreadSessionIds, event.sessionId] };
    case "draft.changed": {
      const key = event.sessionId || DRAFT_SESSION_KEY;
      if (!event.value && !(key in state.draftsBySession)) {
        return state;
      }
      const draftsBySession = { ...state.draftsBySession };
      if (event.value) {
        draftsBySession[key] = event.value;
      } else {
        delete draftsBySession[key];
      }
      return { ...state, draftsBySession };
    }
    case "replace": {
      if (event.previousSessionId === event.sessionId) {
        return state;
      }
      const openSessionIds = unique(state.openSessionIds.map((sessionId) => (
        sessionId === event.previousSessionId ? event.sessionId : sessionId
      )));
      const draftsBySession = { ...state.draftsBySession };
      if (event.previousSessionId in draftsBySession) {
        draftsBySession[event.sessionId] = draftsBySession[event.previousSessionId];
        delete draftsBySession[event.previousSessionId];
      }
      return {
        activeSessionId: state.activeSessionId === event.previousSessionId
          ? event.sessionId
          : state.activeSessionId,
        draftsBySession,
        openSessionIds,
        unreadSessionIds: unique(state.unreadSessionIds.map((sessionId) => (
          sessionId === event.previousSessionId ? event.sessionId : sessionId
        ))),
      };
    }
    case "reconcile": {
      const available = new Set(event.availableSessionIds);
      const openSessionIds = state.openSessionIds.filter((sessionId) => available.has(sessionId));
      const activeSessionId = openSessionIds.includes(state.activeSessionId)
        ? state.activeSessionId
        : openSessionIds[0] ?? "";
      const draftsBySession = Object.fromEntries(
        Object.entries(state.draftsBySession).filter(([sessionId]) => (
          sessionId === DRAFT_SESSION_KEY || available.has(sessionId)
        )),
      );
      return {
        activeSessionId,
        draftsBySession,
        openSessionIds,
        unreadSessionIds: state.unreadSessionIds.filter((sessionId) => (
          sessionId !== activeSessionId && openSessionIds.includes(sessionId)
        )),
      };
    }
  }
}

export function sessionTabDraft(state: SessionTabWorkspaceState, sessionId: string): string {
  return state.draftsBySession[sessionId || DRAFT_SESSION_KEY] ?? "";
}

export function persistedSessionTabWorkspace(
  state: SessionTabWorkspaceState,
): PersistedSessionTabWorkspace {
  return {
    activeSessionId: state.activeSessionId,
    draftsBySession: state.draftsBySession,
    openSessionIds: state.openSessionIds,
  };
}

export function readPersistedSessionTabWorkspace(
  storage: Pick<Storage, "getItem">,
): PersistedSessionTabWorkspace | undefined {
  const serialized = storage.getItem(CHAT_SESSION_TABS_STORAGE_KEY);
  if (!serialized) {
    return undefined;
  }
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value)
      || !Array.isArray(value.openSessionIds)
      || !value.openSessionIds.every((sessionId) => typeof sessionId === "string")
      || typeof value.activeSessionId !== "string"
      || !isStringRecord(value.draftsBySession)) {
      throw new Error("Stored session tab workspace has an invalid shape.");
    }
    return {
      activeSessionId: value.activeSessionId,
      draftsBySession: value.draftsBySession,
      openSessionIds: unique(value.openSessionIds),
    };
  } catch (error) {
    console.warn("[session-tabs] Failed to restore the saved workspace.", error);
    return undefined;
  }
}

export function writePersistedSessionTabWorkspace(
  storage: Pick<Storage, "setItem">,
  state: SessionTabWorkspaceState,
): void {
  storage.setItem(CHAT_SESSION_TABS_STORAGE_KEY, JSON.stringify(persistedSessionTabWorkspace(state)));
}

function hydrateWorkspace(
  availableSessionIds: string[],
  persisted?: PersistedSessionTabWorkspace,
): SessionTabWorkspaceState {
  const available = new Set(availableSessionIds);
  let openSessionIds = unique(persisted?.openSessionIds ?? []).filter((sessionId) => available.has(sessionId));
  if (!persisted && !openSessionIds.length && availableSessionIds[0]) {
    openSessionIds = [availableSessionIds[0]];
  }
  const activeSessionId = persisted?.activeSessionId
    && openSessionIds.includes(persisted.activeSessionId)
    ? persisted.activeSessionId
    : openSessionIds[0] ?? "";
  const draftsBySession = Object.fromEntries(
    Object.entries(persisted?.draftsBySession ?? {}).filter(([sessionId]) => (
      sessionId === DRAFT_SESSION_KEY || available.has(sessionId)
    )),
  );
  return {
    activeSessionId,
    draftsBySession,
    openSessionIds,
    unreadSessionIds: [],
  };
}

function withoutValue(values: string[], value: string): string[] {
  return values.filter((candidate) => candidate !== value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
