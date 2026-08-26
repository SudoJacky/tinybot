import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import type {
  ProjectGroup,
  ProjectGroupStore,
  SessionSummary,
} from "../services";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import { ProjectGroupDialog } from "./ProjectGroupDialog";
import { projectSessionGroups } from "./projectSessionGroups";
import { displaySessionTitle } from "./sessionTitle";
import { groupSessionsByWorkspace, sessionWorkspaceName } from "./sessionWorkspaces";

export type ProjectSessionContext = {
  projectCoordinator?: boolean;
  projectGroupId: string;
  title?: string;
};

export type ChatSessionWorkspaceActions = {
  onCancelDeleteConfirmation: (sessionId: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreateSession: (
    workingDirectory?: string,
    projectContext?: ProjectSessionContext,
  ) => Promise<SessionSummary | null>;
  onDeleteSession: (session: SessionSummary) => Promise<void>;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  onSelectSession: (session: SessionSummary) => void;
};

export function ChatSessionWorkspace({
  actions,
  activeSessionId,
  children,
  collapsed,
  confirmingDeleteSessionId,
  createPending,
  dissolvingSessionIds,
  error,
  now,
  projectGroupStore,
  sessions,
}: {
  actions: ChatSessionWorkspaceActions;
  activeSessionId: string;
  children: ReactNode;
  collapsed: boolean;
  confirmingDeleteSessionId: string;
  createPending: boolean;
  dissolvingSessionIds: ReadonlySet<string>;
  error: string;
  now: () => number;
  projectGroupStore?: ProjectGroupStore;
  sessions: readonly SessionSummary[];
}) {
  const { t } = useTranslation("chat");
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [projectDialogGroupId, setProjectDialogGroupId] = useState<string | "new">();
  const [searchOpen, setSearchOpen] = useState(false);
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
  const workspaceActionMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!projectGroupStore) {
      setProjectGroups([]);
      return;
    }
    let cancelled = false;
    void projectGroupStore.list().then((groups) => {
      if (!cancelled) {
        setProjectGroups(groups);
        setWorkspaceError("");
      }
    }).catch((cause) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setWorkspaceError(message);
      console.error("[session-workspaces] project-groups.load.failed", { error: message });
    });
    return () => {
      cancelled = true;
    };
  }, [projectGroupStore]);

  useEffect(() => {
    if (!workspaceActionMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceActionMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceActionMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [workspaceActionMenuOpen]);

  const projectProjection = useMemo(
    () => projectSessionGroups(projectGroups, [...sessions]),
    [projectGroups, sessions],
  );
  const sessionWorkspaces = useMemo(
    () => groupSessionsByWorkspace(projectProjection.ungroupedSessions).map((workspace) => ({
      ...workspace,
      label: workspace.label ?? t("shell.generalSessions"),
    })),
    [projectProjection.ungroupedSessions, t],
  );
  const availableProjectWorkspaceIds = useMemo(() => Array.from(new Set([
    ...sessions.flatMap((session) => session.workingDirectory ? [session.workingDirectory] : []),
    ...projectGroups.flatMap((group) => group.workspaceIds),
  ])), [projectGroups, sessions]);
  const projectDialogGroup = projectDialogGroupId && projectDialogGroupId !== "new"
    ? projectGroups.find((group) => group.projectGroupId === projectDialogGroupId)
    : undefined;
  const displayError = error || workspaceError;

  function renderSidebarSessionRow(session: SessionSummary, index: number) {
    const confirming = confirmingDeleteSessionId === session.id;
    const dissolving = dissolvingSessionIds.has(session.id);
    return (
      <div
        className="react-session-row"
        data-active={session.id === activeSessionId}
        data-confirming={confirming}
        data-dissolving={dissolving ? "true" : undefined}
        data-motion-role="item"
        key={session.id}
        onMouseLeave={() => actions.onCancelDeleteConfirmation(session.id)}
        style={{ "--react-session-row-index": String(index) } as CSSProperties}
      >
        <button
          aria-label={session.title}
          className="react-session-row__select"
          type="button"
          disabled={dissolving}
          onClick={() => actions.onSelectSession(session)}
        >
          <span className="react-session-row__title">{displaySessionTitle(session.title, t)}</span>
          <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
        </button>
        <button
          aria-label={t(confirming ? "shell.confirmDelete" : "shell.delete", { name: session.title })}
          className="react-session-row__delete"
          data-confirming={confirming}
          type="button"
          disabled={dissolving}
          onClick={() => void actions.onDeleteSession(session)}
        >
          <Trash2 aria-hidden="true" size={15} />
        </button>
      </div>
    );
  }

  async function handleAddWorkspace(): Promise<void> {
    if (workspacePickerPending || createPending) return;
    setWorkspacePickerPending(true);
    setWorkspaceError("");
    try {
      const workingDirectory = await pickDesktopWorkspaceDirectory();
      if (workingDirectory) {
        await actions.onCreateSession(workingDirectory);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setWorkspaceError(message);
      console.error("[session-workspaces] workspace.pick.failed", { error: message });
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  async function handleSaveProjectGroup(input: {
    projectGroupId?: string;
    name: string;
    workspaceIds: string[];
  }): Promise<void> {
    if (!projectGroupStore) throw new Error(t("projectGroups.unavailable"));
    const saved = await projectGroupStore.save(input);
    setProjectGroups((current) => {
      const existing = current.findIndex((group) => group.projectGroupId === saved.projectGroupId);
      if (existing < 0) return [...current, saved];
      const next = [...current];
      next[existing] = saved;
      return next;
    });
  }

  async function handleDeleteProjectGroup(projectGroupId: string): Promise<void> {
    if (!projectGroupStore) throw new Error(t("projectGroups.unavailable"));
    await projectGroupStore.delete(projectGroupId);
    setProjectGroups((current) => current.filter((group) => group.projectGroupId !== projectGroupId));
  }

  async function handleChooseProjectWorkspace(): Promise<string | undefined> {
    if (workspacePickerPending) return undefined;
    setWorkspacePickerPending(true);
    try {
      return await pickDesktopWorkspaceDirectory() || undefined;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("[session-workspaces] project-workspace.pick.failed", { error: message });
      throw cause;
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  function handleCreateCoordinatorSession(project: ProjectGroup): void {
    void actions.onCreateSession(undefined, {
      projectCoordinator: true,
      projectGroupId: project.projectGroupId,
      title: t("projectGroups.newCoordinatorTitle", { name: project.name }),
    });
  }

  async function handleCreateSessionFromSearch(): Promise<void> {
    const created = await actions.onCreateSession();
    if (created) setSearchOpen(false);
  }

  function handleSelectSession(session: SessionSummary): void {
    actions.onSelectSession(session);
    setSearchOpen(false);
  }

  return (
    <>
      <aside className="react-session-list" aria-label={t("shell.sessions")} data-collapsed={collapsed}>
        <div className="react-session-list__header">
          <div className="react-session-list__title-row">
            <h2>Tinybot</h2>
            <div className="react-session-list__title-actions">
              <div className="react-session-list__workspace-actions" ref={workspaceActionMenuRef}>
                <button
                  aria-expanded={workspaceActionMenuOpen}
                  aria-haspopup="menu"
                  aria-label={t("shell.workspaceActions")}
                  className="react-session-list__add-workspace"
                  disabled={workspacePickerPending || createPending}
                  title={t("shell.workspaceActions")}
                  type="button"
                  onClick={() => setWorkspaceActionMenuOpen((open) => !open)}
                >
                  <FolderPlus aria-hidden="true" size={15} />
                </button>
                {workspaceActionMenuOpen ? (
                  <div aria-label={t("shell.workspaceActions")} className="react-session-list__workspace-menu" role="menu">
                    <button
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setWorkspaceActionMenuOpen(false);
                        void handleAddWorkspace();
                      }}
                    >
                      <FolderPlus aria-hidden="true" size={14} />
                      {t("shell.addWorkspace")}
                    </button>
                    <button
                      disabled={!projectGroupStore}
                      role="menuitem"
                      type="button"
                      onClick={() => {
                        setWorkspaceActionMenuOpen(false);
                        setProjectDialogGroupId("new");
                      }}
                    >
                      <GitBranch aria-hidden="true" size={14} />
                      {t("projectGroups.create")}
                    </button>
                  </div>
                ) : null}
              </div>
              <button
                aria-label={t("shell.searchChats")}
                className="react-session-list__search"
                title={t("shell.searchChats")}
                type="button"
                onClick={() => setSearchOpen(true)}
              >
                <Search aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
                className="react-session-list__collapse"
                title={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
                type="button"
                onClick={() => actions.onCollapsedChange(!collapsed)}
              >
                <ChevronLeft aria-hidden="true" data-direction={collapsed ? "expand" : "collapse"} size={16} />
              </button>
            </div>
          </div>
          {displayError ? (
            <p className="react-session-list__error" role="alert">{displayError}</p>
          ) : null}
        </div>
        <div className="react-session-list__rows" aria-label={t("shell.sessionRows")} data-motion="animated-list">
          {projectProjection.groups.map((projectGroup) => {
            const projectSessions = [
              ...projectGroup.coordinatorSessions,
              ...projectGroup.workspaces.flatMap((workspace) => workspace.sessions),
            ];
            return (
              <details
                aria-label={t("projectGroups.groupLabel", { name: projectGroup.project.name })}
                className="react-project-group"
                data-active={projectSessions.some((session) => session.id === activeSessionId) ? "true" : undefined}
                key={projectGroup.project.projectGroupId}
                open
                role="group"
              >
                <summary title={projectGroup.project.name}>
                  <ChevronRight aria-hidden="true" className="react-project-group__chevron" size={14} />
                  <GitBranch aria-hidden="true" className="react-project-group__icon" size={15} />
                  <strong>{projectGroup.project.name}</strong>
                </summary>
                <div className="react-project-group__actions">
                  <button
                    aria-label={t("projectGroups.newCoordinator", { name: projectGroup.project.name })}
                    disabled={createPending}
                    onClick={() => handleCreateCoordinatorSession(projectGroup.project)}
                    title={t("projectGroups.newCoordinator", { name: projectGroup.project.name })}
                    type="button"
                  >
                    <Plus aria-hidden="true" size={14} />
                  </button>
                  <button
                    aria-label={t("projectGroups.edit", { name: projectGroup.project.name })}
                    onClick={() => setProjectDialogGroupId(projectGroup.project.projectGroupId)}
                    title={t("projectGroups.edit", { name: projectGroup.project.name })}
                    type="button"
                  >
                    <MoreHorizontal aria-hidden="true" size={15} />
                  </button>
                </div>
                <div className="react-project-group__content">
                  {projectGroup.coordinatorSessions.length ? (
                    <section className="react-project-group__coordinators">
                      <div className="react-project-group__member-title">
                        <GitBranch aria-hidden="true" size={13} />
                        <span>{t("projectGroups.coordination")}</span>
                      </div>
                      {projectGroup.coordinatorSessions.map(renderSidebarSessionRow)}
                    </section>
                  ) : null}
                  {projectGroup.workspaces.map((workspace) => (
                    <section className="react-project-workspace" key={workspace.workspaceId}>
                      <div className="react-project-group__member-title" title={workspace.workspaceId}>
                        <Folder aria-hidden="true" size={13} />
                        <span>
                          <strong>{workspace.label}</strong>
                          <small>{workspace.workspaceId}</small>
                        </span>
                        <button
                          aria-label={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          disabled={createPending}
                          onClick={() => void actions.onCreateSession(workspace.workspaceId, {
                            projectGroupId: projectGroup.project.projectGroupId,
                          })}
                          title={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          type="button"
                        >
                          <Plus aria-hidden="true" size={13} />
                        </button>
                      </div>
                      <div className="react-project-workspace__sessions">
                        {workspace.sessions.map(renderSidebarSessionRow)}
                      </div>
                    </section>
                  ))}
                </div>
              </details>
            );
          })}
          {sessionWorkspaces.length ? sessionWorkspaces.map((workspace) => (
            <details
              aria-label={t("shell.workspace", { name: workspace.label })}
              className="react-session-workspace"
              data-active={workspace.sessions.some((session) => session.id === activeSessionId) ? "true" : undefined}
              key={workspace.key}
              open
              role="group"
            >
              <summary title={workspace.workingDirectory ?? workspace.label}>
                <ChevronRight aria-hidden="true" className="react-session-workspace__chevron" size={14} />
                <span aria-hidden="true" className="react-session-workspace__folder">
                  <Folder className="react-session-workspace__folder-icon--collapsed" size={15} />
                  <FolderOpen className="react-session-workspace__folder-icon--expanded" size={15} />
                </span>
                <span className="react-session-workspace__copy">
                  <strong>{workspace.label}</strong>
                  {workspace.workingDirectory ? <small>{workspace.workingDirectory}</small> : null}
                </span>
              </summary>
              <button
                aria-label={t("shell.newSessionIn", { name: workspace.label })}
                className="react-session-workspace__new"
                disabled={createPending}
                title={t("shell.newSessionIn", { name: workspace.label })}
                type="button"
                onClick={() => void actions.onCreateSession(workspace.workingDirectory)}
              >
                <Plus aria-hidden="true" size={15} />
              </button>
              <div className="react-session-workspace__sessions">
                {workspace.sessions.map(renderSidebarSessionRow)}
              </div>
            </details>
          )) : null}
          {!projectProjection.groups.length && !sessionWorkspaces.length && !collapsed
            ? <EmptyStateText text={t("shell.noSessions")} />
            : null}
        </div>
      </aside>
      {children}
      {searchOpen ? (
        <SessionSearchDialog
          activeSessionId={activeSessionId}
          now={now}
          sessions={[...sessions]}
          onClose={() => setSearchOpen(false)}
          onCreateSession={() => void handleCreateSessionFromSearch()}
          onOpenFiles={actions.onOpenFiles}
          onOpenSettings={actions.onOpenSettings}
          onSelectSession={handleSelectSession}
        />
      ) : null}
      {projectDialogGroupId ? (
        <ProjectGroupDialog
          availableWorkspaceIds={availableProjectWorkspaceIds}
          group={projectDialogGroup}
          onChooseWorkspace={handleChooseProjectWorkspace}
          onClose={() => setProjectDialogGroupId(undefined)}
          onDelete={projectDialogGroup ? handleDeleteProjectGroup : undefined}
          onSave={handleSaveProjectGroup}
        />
      ) : null}
    </>
  );
}

function EmptyStateText({ text }: { text: string }) {
  return <p className="react-empty-state">{text}</p>;
}

function SessionSearchDialog({
  activeSessionId,
  now,
  onClose,
  onCreateSession,
  onOpenFiles,
  onOpenSettings,
  onSelectSession,
  sessions,
}: {
  activeSessionId: string;
  now: () => number;
  onClose: () => void;
  onCreateSession: () => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  onSelectSession: (session: SessionSummary) => void;
  sessions: SessionSummary[];
}) {
  const { i18n, t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => [session.title, session.chatId ?? "", session.id, session.workingDirectory ?? ""]
      .some((value) => value.toLowerCase().includes(normalizedQuery)))
    : sessions;
  const recommendations = [
    {
      id: "new-chat",
      label: t("shell.newChat"),
      shortcut: "Ctrl+N",
      icon: Plus,
      run: onCreateSession,
    },
    ...(onOpenFiles ? [{
      id: "open-files",
      label: t("search.openFolder"),
      shortcut: "Ctrl+O",
      icon: FolderOpen,
      run: () => {
        onOpenFiles();
        onClose();
      },
    }] : []),
    ...(onOpenSettings ? [{
      id: "open-settings",
      label: t("search.settings"),
      shortcut: "Ctrl+,",
      icon: Settings,
      run: () => {
        onOpenSettings();
        onClose();
      },
    }] : []),
  ];

  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLElement>({ onClose });

  return (
    <div
      className="react-command-palette-backdrop react-session-search-backdrop"
      onPointerDown={onBackdropPointerDown}
    >
      <section
        aria-label={t("search.label")}
        aria-modal="true"
        className="react-command-palette react-session-search-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="react-session-search__input-row">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label={t("search.placeholder")}
            data-dialog-initial-focus
            placeholder={t("search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="react-session-search__section">
          <p>{t("search.chats")}</p>
          <div className="react-session-search__list">
            {filteredSessions.length ? filteredSessions.map((session, index) => (
              <button
                aria-current={session.id === activeSessionId ? "page" : undefined}
                className="react-session-search__item"
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
              >
                <span className="react-session-search__rank">{index + 1}</span>
                <span className="react-session-search__title">{session.title}</span>
                <span className="react-session-search__meta">
                  {session.workingDirectory ? sessionWorkspaceName(session.workingDirectory) : t("search.regular")}
                </span>
                <kbd>{`Ctrl+${index + 1}`}</kbd>
                <small>{formatRelativeUpdatedTime(session.updatedAtMs, now(), i18n.language, t("search.noDate"))}</small>
              </button>
            )) : <span className="react-session-search__empty">{t("search.noMatches")}</span>}
          </div>
        </div>
        <div className="react-session-search__section">
          <p>{t("search.suggested")}</p>
          <div className="react-session-search__list">
            {recommendations.map((recommendation) => {
              const Icon = recommendation.icon;
              return (
                <button className="react-session-search__item" key={recommendation.id} type="button" onClick={recommendation.run}>
                  <Icon aria-hidden="true" size={17} />
                  <span className="react-session-search__title">{recommendation.label}</span>
                  <kbd>{recommendation.shortcut}</kbd>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
