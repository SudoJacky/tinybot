import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { SessionStore, SessionSummary } from "../services";
import { projectTimelineSessionStatus } from "./chatEventPolicy";
import { isDefaultSessionTitle } from "./sessionTitle";
import type { DraftSession, DraftSessionCreateInput } from "./sessionTabWorkspace";

export type ChatSessionChange =
  | { type: "loaded" | "reconciled"; sessions: SessionSummary[] }
  | { type: "created"; session: SessionSummary; previousSessionId?: string }
  | { type: "replaced"; previousSessionId: string; sessionId: string }
  | { type: "removed"; session: SessionSummary; reason: "delete" | "archive" };

export function createChatSessionApplication(store: SessionStore, now: () => number = Date.now) {
  let state = { sessions: [] as SessionSummary[], loaded: false, error: "", creating: false };
  const listeners = new Set<() => void>();
  const changes = new Set<(event: ChatSessionChange) => void>();
  const titles = new Map<string, string>();
  const creations = new Map<string, Promise<SessionSummary>>();
  let draftSequence = 0;
  const emit = (event: ChatSessionChange) => changes.forEach((listener) => listener(event));
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const updateSession = (id: string, patch: Partial<SessionSummary>) => {
    publish({ sessions: state.sessions.map((session) => session.id === id ? { ...session, ...patch } : session) });
  };
  function accept(session: SessionSummary, previousSessionId?: string) {
    publish({ sessions: [session, ...state.sessions.filter((candidate) => candidate.id !== session.id)] });
    emit({ type: "created", session, previousSessionId });
  }
  async function load() {
    try {
      const sessions = await store.list();
      publish({ sessions, loaded: true, error: "" });
      emit({ type: "loaded", sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publish({ error: message });
      console.error("[chat-sessions] load.failed", { error: message });
    }
  }
  async function refresh(preserveSession?: SessionSummary): Promise<SessionSummary[]> {
    const listedSessions = await store.list();
    let titledSessions = listedSessions.map((session) => {
      if (!isDefaultSessionTitle(session.title)) { titles.delete(session.id); return session; }
      const title = titles.get(session.id);
      return title ? { ...session, title } : session;
    });
    const listedIds = new Set(titledSessions.map((session) => session.id));
    const knownIds = new Set(state.sessions.map((session) => session.id));
    const missing = state.sessions.filter((session) => titles.has(session.id) && !listedIds.has(session.id));
    const replacements = titledSessions.filter((session) => !knownIds.has(session.id));
    let replacement: { previousSessionId: string; sessionId: string } | undefined;
    if (missing.length === 1 && replacements.length === 1) {
      const pending = missing[0];
      const persisted = replacements[0];
      replacement = { previousSessionId: pending.id, sessionId: persisted.id };
      const title = titles.get(pending.id);
      titles.delete(pending.id);
      if (title && isDefaultSessionTitle(persisted.title)) {
        titles.set(persisted.id, title);
        titledSessions = titledSessions.map((session) => session.id === persisted.id ? { ...session, title } : session);
      }
    }
    const pending = state.sessions.filter((session) => titles.has(session.id) && !listedIds.has(session.id))
      .map((session) => ({ ...session, title: titles.get(session.id) ?? session.title }));
    const visible = [...pending, ...titledSessions];
    const preserveTitle = preserveSession && !isDefaultSessionTitle(preserveSession.title);
    const sessions = preserveSession && !visible.some((session) => session.id === preserveSession.id)
      ? [preserveSession, ...visible]
      : visible.map((session) => preserveTitle && session.id === preserveSession.id && isDefaultSessionTitle(session.title)
        ? { ...session, title: preserveSession.title } : session);
    publish({ sessions });
    if (replacement) emit({ type: "replaced", ...replacement });
    emit({ type: "reconciled", sessions });
    return sessions;
  }
  async function remove(session: SessionSummary, reason: "delete" | "archive") {
    await store[reason](session.id);
    titles.delete(session.id);
    publish({ sessions: state.sessions.filter((candidate) => candidate.id !== session.id) });
    emit({ type: "removed", session, reason });
  }

  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onChange(listener: (event: ChatSessionChange) => void) { changes.add(listener); return () => { changes.delete(listener); }; },
    load, refresh, accept,
    preview(session: SessionSummary) { titles.set(session.id, session.title); updateSession(session.id, session); },
    createDraft(input: DraftSessionCreateInput): DraftSession {
      publish({ error: "" });
      const createdAtMs = now();
      return { id: `draft:${createdAtMs}:${++draftSequence}`, createdAtMs, createInput: input };
    },
    materializeDraft(draftId: string, draft: DraftSession | undefined, model: { model?: string; modelProvider?: string }) {
      const pending = creations.get(draftId);
      if (pending) return pending;
      const input = { ...draft?.createInput, ...model };
      publish({ creating: true, error: "" });
      const creation = store.create(draft || Object.keys(input).length ? input : undefined)
        .then((session) => { accept(session, draftId); return session; })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          publish({ error: message });
          console.error("[session-workspaces] session.create.failed", { draftId, error: message, workingDirectory: input.workingDirectory, projectGroupId: input.projectGroupId });
          throw error;
        }).finally(() => {
          creations.delete(draftId);
          publish({ creating: creations.size > 0 });
        });
      creations.set(draftId, creation);
      return creation;
    },
    async activateExternal(sessionId: string) {
      const sessions = store.refresh ? await store.refresh() : await store.list();
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Cannot activate unknown Thread ${sessionId}`);
      publish({ sessions });
      return session;
    },
    delete(session: SessionSummary) { return remove(session, "delete"); },
    archive(session: SessionSummary) { return remove(session, "archive"); },
    async rename(sessionId: string, title: string) {
      await store.rename(sessionId, title);
      titles.delete(sessionId);
      updateSession(sessionId, { title });
    },
    async pin(sessionId: string, pinned: boolean) {
      await store.pin(sessionId, pinned);
      updateSession(sessionId, { pinned });
    },
    async selectModel(sessionId: string, model: string, modelProvider?: string) {
      updateSession(sessionId, { model, modelProvider });
      if (modelProvider) await store.setModel?.(sessionId, model, modelProvider);
      else await store.setModel?.(sessionId, model);
    },
    async recordMigration(sessionId: string, migration: NonNullable<SessionSummary["pluginMigration"]>) {
      updateSession(sessionId, { pluginMigration: migration });
      await store.markPluginMigrationInstalled?.(sessionId, migration.installedPluginName!, migration.installedPluginEnabled!, migration.cleanupWarning);
    },
    receiveTimeline(sessionId: string, timeline: ChatTimelineSnapshot) {
      const status = projectTimelineSessionStatus(timeline);
      if (status && state.sessions.some((session) => session.id === sessionId && session.status !== status)) updateSession(sessionId, { status });
    },
  };
}

export type ChatSessionApplication = ReturnType<typeof createChatSessionApplication>;
