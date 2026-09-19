import type { ComposerFileReference } from "../../components/ui/claude-style-ai-input";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { SpreadsheetComposerAnnotation } from "./chatSubmission";

export type ComposerDraftContext = {
  files: ComposerFileReference[];
  sessionMentionIds: string[];
  skillIds: string[];
  artifactReferences: (AgentInputReference & { id: string })[];
  spreadsheetAnnotations: SpreadsheetComposerAnnotation[];
};
export const EMPTY_COMPOSER_CONTEXT: ComposerDraftContext = { files: [], sessionMentionIds: [], skillIds: [], artifactReferences: [], spreadsheetAnnotations: [] };
export function sessionTabContext(state: Pick<SessionTabWorkspaceState, "contextsBySession">, sessionId: string): ComposerDraftContext {
  return state.contextsBySession?.[composerDraftKey(sessionId)] ?? EMPTY_COMPOSER_CONTEXT;
}
export function hasComposerContext(context: ComposerDraftContext): boolean { return Object.values(context).some((items) => items.length > 0); }

export const CHAT_SESSION_TABS_STORAGE_KEY = "tinybot.ui.chat.session-tabs.v1";
export const DRAFT_SESSION_KEY = "__tinybot_draft_session__";

export type DraftSessionCreateInput = {
  projectCoordinator?: boolean;
  projectGroupId?: string;
  title?: string;
  workingDirectory?: string;
};

export type DraftSession = {
  id: string;
  createdAtMs: number;
  createInput: DraftSessionCreateInput;
};

export type SessionTabWorkspaceState = {
  activeSessionId: string;
  draftSessionsById: Record<string, DraftSession>;
  draftsBySession: Record<string, string>;
  contextsBySession?: Record<string, ComposerDraftContext>;
  openSessionIds: string[];
  unreadSessionIds: string[];
};

export type PersistedSessionTabWorkspace = Pick<
  SessionTabWorkspaceState,
  "activeSessionId" | "draftsBySession" | "openSessionIds" | "contextsBySession"
> & {
  draftSessionsById?: Record<string, DraftSession>;
};

export type SessionTabWorkspaceEvent =
  | { type: "context.changed"; sessionId: string; update: (context: ComposerDraftContext) => ComposerDraftContext }
  | { type: "hydrate"; availableSessionIds: string[]; persisted?: PersistedSessionTabWorkspace }
  | { type: "open"; sessionId: string }
  | { type: "activate"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "remove"; sessionId: string }
  | { type: "activity"; sessionId: string }
  | { type: "draft.changed"; sessionId: string; value: string }
  | { type: "session-draft.workspace.changed"; sessionId: string; workingDirectory?: string }
  | { type: "startup-draft.materialize"; draft: DraftSession }
  | { type: "session-draft.open"; draft: DraftSession }
  | { type: "replace"; previousSessionId: string; sessionId: string }
  | { type: "reconcile"; availableSessionIds: string[] };

export const INITIAL_SESSION_TAB_WORKSPACE: SessionTabWorkspaceState = {
  activeSessionId: "",
  draftSessionsById: {},
  draftsBySession: {},
  openSessionIds: [],
  unreadSessionIds: [],
};

export function reduceSessionTabWorkspace(
  state: SessionTabWorkspaceState,
  event: SessionTabWorkspaceEvent,
): SessionTabWorkspaceState {
  switch (event.type) {
    case "context.changed": {
      const contextsBySession = { ...state.contextsBySession };
      const key = composerDraftKey(event.sessionId);
      const context = event.update(sessionTabContext(state, event.sessionId));
      if (hasComposerContext(context)) contextsBySession[key] = context;
      else delete contextsBySession[key];
      return { ...state, contextsBySession };
    }
    case "hydrate": {
      const hydrated = hydrateWorkspace(event.availableSessionIds, event.persisted);
      const startupDraft = state.draftsBySession[DRAFT_SESSION_KEY];
      if (!startupDraft && !hasComposerContext(sessionTabContext(state, ""))) {
        return hydrated;
      }
      return {
        ...hydrated,
        contextsBySession: { ...hydrated.contextsBySession, ...state.contextsBySession },
        activeSessionId: "",
        draftsBySession: {
          ...hydrated.draftsBySession,
          [DRAFT_SESSION_KEY]: startupDraft ?? "",
        },
      };
    }
    case "startup-draft.materialize": {
      const startupText = sessionTabDraft(state, "");
      if (state.activeSessionId || (!startupText.trim() && !hasComposerContext(sessionTabContext(state, "")))) {
        return state;
      }
      const draftsBySession = { ...state.draftsBySession };
      delete draftsBySession[DRAFT_SESSION_KEY];
      draftsBySession[event.draft.id] = startupText;
      const contextsBySession = { ...state.contextsBySession };
      if (contextsBySession[DRAFT_SESSION_KEY]) { contextsBySession[event.draft.id] = contextsBySession[DRAFT_SESSION_KEY]; delete contextsBySession[DRAFT_SESSION_KEY]; }
      return {
        ...state,
        contextsBySession,
        activeSessionId: event.draft.id,
        draftSessionsById: {
          ...state.draftSessionsById,
          [event.draft.id]: event.draft,
        },
        draftsBySession,
        openSessionIds: unique([...state.openSessionIds, event.draft.id]),
        unreadSessionIds: withoutValue(state.unreadSessionIds, event.draft.id),
      };
    }
    case "session-draft.open": {
      const navigable = discardActivePristineDraft(state);
      return {
        ...navigable,
        activeSessionId: event.draft.id,
        draftSessionsById: {
          ...navigable.draftSessionsById,
          [event.draft.id]: event.draft,
        },
        openSessionIds: unique([...navigable.openSessionIds, event.draft.id]),
        unreadSessionIds: withoutValue(navigable.unreadSessionIds, event.draft.id),
      };
    }
    case "open":
    case "activate": {
      const navigable = event.sessionId === state.activeSessionId
        ? state
        : discardActivePristineDraft(state);
      const openSessionIds = navigable.openSessionIds.includes(event.sessionId)
        ? navigable.openSessionIds
        : [...navigable.openSessionIds, event.sessionId];
      return {
        ...navigable,
        activeSessionId: event.sessionId,
        openSessionIds,
        unreadSessionIds: withoutValue(navigable.unreadSessionIds, event.sessionId),
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
      const closed = {
        ...state,
        activeSessionId,
        openSessionIds,
        unreadSessionIds: withoutValue(state.unreadSessionIds, event.sessionId),
      };
      return event.sessionId in state.draftSessionsById
        ? removeDraftSession(closed, event.sessionId)
        : closed;
    }
    case "remove": {
      const closed = reduceSessionTabWorkspace(state, { type: "close", sessionId: event.sessionId });
      const draftsBySession = { ...closed.draftsBySession };
      delete draftsBySession[event.sessionId];
      const contextsBySession = { ...closed.contextsBySession };
      delete contextsBySession[event.sessionId];
      return { ...closed, draftsBySession, contextsBySession };
    }
    case "activity":
      if (event.sessionId === state.activeSessionId
        || !state.openSessionIds.includes(event.sessionId)
        || state.unreadSessionIds.includes(event.sessionId)) {
        return state;
      }
      return { ...state, unreadSessionIds: [...state.unreadSessionIds, event.sessionId] };
    case "draft.changed": {
      const key = composerDraftKey(event.sessionId);
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
    case "session-draft.workspace.changed": {
      const draft = state.draftSessionsById[event.sessionId];
      if (!draft) return state;
      const workingDirectory = event.workingDirectory?.trim() || undefined;
      if (draft.createInput.workingDirectory === workingDirectory) return state;
      const createInput = { ...draft.createInput };
      if (workingDirectory) {
        createInput.workingDirectory = workingDirectory;
      } else {
        delete createInput.workingDirectory;
      }
      return {
        ...state,
        draftSessionsById: {
          ...state.draftSessionsById,
          [event.sessionId]: { ...draft, createInput },
        },
      };
    }
    case "replace": {
      if (event.previousSessionId === event.sessionId) {
        return state;
      }
      let openSessionIds = unique(state.openSessionIds.map((sessionId) => (
        sessionId === event.previousSessionId ? event.sessionId : sessionId
      )));
      if (state.activeSessionId === event.previousSessionId && !openSessionIds.includes(event.sessionId)) {
        openSessionIds = [...openSessionIds, event.sessionId];
      }
      const draftsBySession = { ...state.draftsBySession };
      const previousDraftKey = composerDraftKey(event.previousSessionId);
      if (previousDraftKey in draftsBySession) {
        draftsBySession[event.sessionId] = draftsBySession[previousDraftKey];
        delete draftsBySession[previousDraftKey];
      }
      const draftSessionsById = { ...state.draftSessionsById };
      delete draftSessionsById[event.previousSessionId];
      const contextsBySession = { ...state.contextsBySession };
      if (contextsBySession[previousDraftKey]) { contextsBySession[event.sessionId] = contextsBySession[previousDraftKey]; delete contextsBySession[previousDraftKey]; }
      return {
        ...(state.contextsBySession ? { contextsBySession } : {}),
        activeSessionId: state.activeSessionId === event.previousSessionId
          ? event.sessionId
          : state.activeSessionId,
        draftSessionsById,
        draftsBySession,
        openSessionIds,
        unreadSessionIds: unique(state.unreadSessionIds.map((sessionId) => (
          sessionId === event.previousSessionId ? event.sessionId : sessionId
        ))),
      };
    }
    case "reconcile": {
      const available = new Set([
        ...event.availableSessionIds,
        ...Object.keys(state.draftSessionsById),
      ]);
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
        ...(state.contextsBySession ? { contextsBySession: Object.fromEntries(Object.entries(state.contextsBySession).filter(([id]) => id === DRAFT_SESSION_KEY || available.has(id))) } : {}),
        activeSessionId,
        draftSessionsById: state.draftSessionsById,
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
  return state.draftsBySession[composerDraftKey(sessionId)] ?? "";
}

export function persistedSessionTabWorkspace(
  state: SessionTabWorkspaceState,
): PersistedSessionTabWorkspace {
  const dirtyDraftSessionIds = new Set(Object.keys(state.draftSessionsById).filter((sessionId) => (
    Boolean(sessionTabDraft(state, sessionId).trim()) || hasComposerContext(sessionTabContext(state, sessionId))
  )));
  const draftSessionsById = Object.fromEntries(
    Object.entries(state.draftSessionsById).filter(([sessionId]) => dirtyDraftSessionIds.has(sessionId)),
  );
  const openSessionIds = state.openSessionIds.filter((sessionId) => (
    !(sessionId in state.draftSessionsById) || dirtyDraftSessionIds.has(sessionId)
  ));
  const activeSessionId = state.activeSessionId in state.draftSessionsById
    && !dirtyDraftSessionIds.has(state.activeSessionId)
      ? openSessionIds[0] ?? ""
      : state.activeSessionId;
  return {
    activeSessionId,
    draftSessionsById,
    draftsBySession: state.draftsBySession,
    ...(state.contextsBySession ? { contextsBySession: state.contextsBySession } : {}),
    openSessionIds,
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
      || !isStringRecord(value.draftsBySession)
      || (value.draftSessionsById !== undefined && !isDraftSessionRecord(value.draftSessionsById))) {
      throw new Error("Stored session tab workspace has an invalid shape.");
    }
    return {
      activeSessionId: value.activeSessionId,
      draftSessionsById: value.draftSessionsById ?? {},
      draftsBySession: value.draftsBySession,
      openSessionIds: unique(value.openSessionIds),
      ...(value.contextsBySession ? { contextsBySession: parseComposerContexts(value.contextsBySession) } : {}),
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
  const draftSessionsById = Object.fromEntries(
    Object.entries(persisted?.draftSessionsById ?? {}).filter(([sessionId]) => (
      Boolean(persisted?.draftsBySession[sessionId]?.trim()) || hasComposerContext(sessionTabContext(persisted ?? {}, sessionId))
    )),
  );
  const available = new Set([...availableSessionIds, ...Object.keys(draftSessionsById)]);
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
    ...(persisted?.contextsBySession ? { contextsBySession: Object.fromEntries(Object.entries(persisted.contextsBySession).filter(([id]) => id === DRAFT_SESSION_KEY || available.has(id))) } : {}),
    activeSessionId,
    draftSessionsById,
    draftsBySession,
    openSessionIds,
    unreadSessionIds: [],
  };
}

function discardActivePristineDraft(state: SessionTabWorkspaceState): SessionTabWorkspaceState {
  const draft = state.draftSessionsById[state.activeSessionId];
  if (!draft || sessionTabDraft(state, draft.id).trim() || hasComposerContext(sessionTabContext(state, draft.id))) {
    return state;
  }
  return removeDraftSession(state, draft.id);
}

function removeDraftSession(
  state: SessionTabWorkspaceState,
  sessionId: string,
): SessionTabWorkspaceState {
  const draftSessionsById = { ...state.draftSessionsById };
  delete draftSessionsById[sessionId];
  const draftsBySession = { ...state.draftsBySession };
  delete draftsBySession[sessionId];
  const contextsBySession = { ...state.contextsBySession };
  delete contextsBySession[sessionId];
  const openSessionIds = withoutValue(state.openSessionIds, sessionId);
  return {
    ...state,
    ...(state.contextsBySession ? { contextsBySession } : {}),
    activeSessionId: state.activeSessionId === sessionId
      ? openSessionIds[0] ?? ""
      : state.activeSessionId,
    draftSessionsById,
    draftsBySession,
    openSessionIds,
    unreadSessionIds: withoutValue(state.unreadSessionIds, sessionId),
  };
}

function composerDraftKey(sessionId: string): string {
  return sessionId || DRAFT_SESSION_KEY;
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

function isDraftSessionRecord(value: unknown): value is Record<string, DraftSession> {
  return isRecord(value) && Object.entries(value).every(([sessionId, entry]) => (
    isRecord(entry)
    && entry.id === sessionId
    && typeof entry.createdAtMs === "number"
    && isDraftSessionCreateInput(entry.createInput)
  ));
}

function isDraftSessionCreateInput(value: unknown): value is DraftSessionCreateInput {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (key === "projectCoordinator") return typeof entry === "boolean";
    if (key === "projectGroupId" || key === "title" || key === "workingDirectory") {
      return typeof entry === "string";
    }
    return false;
  });
}

function parseComposerContexts(value: unknown): Record<string, ComposerDraftContext> {
  if (!isRecord(value)) throw new Error("Invalid saved composer contexts");
  for (const context of Object.values(value)) {
    if (!isRecord(context) || !Object.keys(EMPTY_COMPOSER_CONTEXT).every((key) => Array.isArray(context[key]))) throw new Error("Invalid saved composer context");
    if (![...context.sessionMentionIds as unknown[], ...context.skillIds as unknown[]].every((id) => typeof id === "string")) throw new Error("Invalid saved composer selections");
  }
  return value as Record<string, ComposerDraftContext>;
}
