import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
import type {
  ProjectGroup,
  ProjectGroupStore,
  SessionSummary,
  WorkspaceRegistryEntry,
  WorkspaceRegistryStore,
} from "../services";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import { ProjectGroupDialog } from "./ProjectGroupDialog";
import { projectSessionGroups } from "./projectSessionGroups";
import {
  INITIAL_SESSION_SIDEBAR_ORDER,
  orderSidebarItems,
  readSessionSidebarOrder,
  reorderSidebarItems,
  writeSessionSidebarOrder,
  type SessionSidebarOrder,
} from "./sessionSidebarOrder";
import { displaySessionTitle } from "./sessionTitle";
import {
  groupSessionsByWorkspace,
  normalizedWorkspacePathKey,
} from "./sessionWorkspaces";

const SIDEBAR_ROOT_CONTAINER_ID = "sidebar:root";

type SidebarOrderItem = {
  itemId: string;
  label: string;
};

type SidebarDragItem = SidebarOrderItem & {
  containerId: string;
};

type SidebarDropTarget = SidebarDragItem & {
  placement: "after" | "before";
};

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
  workspaceRegistryStore,
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
  workspaceRegistryStore: WorkspaceRegistryStore;
}) {
  const { t } = useTranslation("chat");
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRegistryEntry[]>([]);
  const [projectDialogGroupId, setProjectDialogGroupId] = useState<string | "new">();
  const [workspaceDialogPath, setWorkspaceDialogPath] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceActionMenuOpen, setWorkspaceActionMenuOpen] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false);
  const workspaceMutationRevisionRef = useRef(0);
  const [sidebarOrder, setSidebarOrder] = useState<SessionSidebarOrder>(() => (
    typeof window === "undefined"
      ? INITIAL_SESSION_SIDEBAR_ORDER
      : readSessionSidebarOrder(window.localStorage)
  ));
  const [draggedSidebarItem, setDraggedSidebarItem] = useState<SidebarDragItem>();
  const [sidebarDropTarget, setSidebarDropTarget] = useState<SidebarDropTarget>();
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSearchTriggerFocusRef = useRef(false);
  const workspaceActionMenuRef = useRef<HTMLDivElement | null>(null);
  const draggedSidebarItemRef = useRef<SidebarDragItem | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const workspaceMutationRevision = workspaceMutationRevisionRef.current;
    void Promise.all([
      projectGroupStore?.list() ?? Promise.resolve([]),
      workspaceRegistryStore.list(),
    ]).then(([groups, registeredWorkspaces]) => {
      if (!cancelled) {
        setProjectGroups(groups);
        if (workspaceMutationRevisionRef.current === workspaceMutationRevision) {
          setWorkspaces(registeredWorkspaces);
        }
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
  }, [projectGroupStore, workspaceRegistryStore]);

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

  useEffect(() => {
    if (typeof window !== "undefined") {
      writeSessionSidebarOrder(window.localStorage, sidebarOrder);
    }
  }, [sidebarOrder]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    } else if (restoreSearchTriggerFocusRef.current) {
      restoreSearchTriggerFocusRef.current = false;
      searchTriggerRef.current?.focus();
    }
  }, [searchOpen]);

  const workspaceByKey = useMemo(() => new Map(workspaces.map((workspace) => [
    normalizedWorkspacePathKey(workspace.path),
    workspace,
  ])), [workspaces]);
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleSessions = useMemo(() => (
    normalizedSearchQuery
      ? sessions.filter((session) => (
          [session.title, session.chatId ?? "", session.id, session.workingDirectory ?? ""]
            .some((value) => value.toLocaleLowerCase().includes(normalizedSearchQuery))
        ))
      : sessions
  ), [normalizedSearchQuery, sessions]);
  const projectProjection = useMemo(() => {
    const projection = projectSessionGroups(projectGroups, [...visibleSessions]);
    return {
      ...projection,
      groups: projection.groups.flatMap((group) => {
        const visibleWorkspaces = group.workspaces
          .map((workspace) => ({
            ...workspace,
            label: workspaceByKey.get(normalizedWorkspacePathKey(workspace.workspaceId))?.name
              ?? workspace.label,
          }))
          .filter((workspace) => !normalizedSearchQuery || workspace.sessions.length);
        return normalizedSearchQuery && !group.coordinatorSessions.length && !visibleWorkspaces.length
          ? []
          : [{ ...group, workspaces: visibleWorkspaces }];
      }),
    };
  }, [normalizedSearchQuery, projectGroups, visibleSessions, workspaceByKey]);
  const sessionWorkspaces = useMemo(
    () => {
      const groups = groupSessionsByWorkspace(projectProjection.ungroupedSessions).map((workspace) => {
        const registered = workspace.workingDirectory
          ? workspaceByKey.get(normalizedWorkspacePathKey(workspace.workingDirectory))
          : undefined;
        return {
          ...workspace,
          exists: registered?.exists ?? true,
          label: registered?.name ?? workspace.label ?? t("shell.generalSessions"),
          registered: Boolean(registered),
          workingDirectory: registered?.path ?? workspace.workingDirectory,
        };
      });
      const represented = new Set(groups.flatMap((workspace) => (
        workspace.workingDirectory
          ? [normalizedWorkspacePathKey(workspace.workingDirectory)]
          : []
      )));
      const projectWorkspaceKeys = new Set(projectGroups.flatMap((group) => (
        group.workspaceIds.map(normalizedWorkspacePathKey)
      )));
      const emptyRegisteredGroups = normalizedSearchQuery ? [] : workspaces.flatMap((workspace) => {
        const key = normalizedWorkspacePathKey(workspace.path);
        if (represented.has(key) || projectWorkspaceKeys.has(key)) return [];
        return [{
          exists: workspace.exists,
          key: `session-workspace:${key}`,
          label: workspace.name,
          registered: true,
          sessions: [],
          updatedAtMs: workspace.updatedAtMs,
          workingDirectory: workspace.path,
        }];
      });
      return [...groups, ...emptyRegisteredGroups];
    },
    [normalizedSearchQuery, projectGroups, projectProjection.ungroupedSessions, t, workspaceByKey, workspaces],
  );
  const rootGroups = useMemo(() => orderSidebarItems([
    ...projectProjection.groups.map((group) => ({
      group,
      itemId: sidebarProjectGroupId(group.project.projectGroupId),
      kind: "project" as const,
      label: group.project.name,
    })),
    ...sessionWorkspaces.map((workspace) => ({
      itemId: sidebarWorkspaceGroupId(workspace.key),
      kind: "workspace" as const,
      label: workspace.label,
      workspace,
    })),
  ], sidebarOrder, SIDEBAR_ROOT_CONTAINER_ID, (item) => item.itemId), [
    projectProjection.groups,
    sessionWorkspaces,
    sidebarOrder,
  ]);
  const rootOrderItems = useMemo<SidebarOrderItem[]>(() => rootGroups.map((group) => ({
    itemId: group.itemId,
    label: group.label,
  })), [rootGroups]);
  const projectDialogGroup = projectDialogGroupId && projectDialogGroupId !== "new"
    ? projectGroups.find((group) => group.projectGroupId === projectDialogGroupId)
    : undefined;
  const workspaceDialogEntry = workspaceDialogPath
    ? workspaceByKey.get(normalizedWorkspacePathKey(workspaceDialogPath))
    : undefined;
  const displayError = error || workspaceError;

  function beginSidebarDrag(
    event: ReactDragEvent<HTMLElement>,
    item: SidebarDragItem,
  ): void {
    draggedSidebarItemRef.current = item;
    setDraggedSidebarItem(item);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.itemId);
  }

  function finishSidebarDrag(): void {
    draggedSidebarItemRef.current = undefined;
    setDraggedSidebarItem(undefined);
    setSidebarDropTarget(undefined);
  }

  function updateSidebarDropTarget(
    event: ReactDragEvent<HTMLElement>,
    target: SidebarDragItem,
  ): void {
    const dragged = draggedSidebarItemRef.current;
    if (!dragged || dragged.containerId !== target.containerId || dragged.itemId === target.itemId) {
      setSidebarDropTarget(undefined);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < bounds.top + (bounds.height / 2) ? "before" : "after";
    setSidebarDropTarget({ ...target, placement });
  }

  function moveSidebarItem(
    dragged: SidebarDragItem,
    target: SidebarOrderItem,
    placement: "after" | "before",
    currentItems: readonly SidebarOrderItem[],
  ): void {
    const nextOrder = reorderSidebarItems(sidebarOrder, {
      containerId: dragged.containerId,
      currentItemIds: currentItems.map((item) => item.itemId),
      draggedItemId: dragged.itemId,
      placement,
      targetItemId: target.itemId,
    });
    if (nextOrder === sidebarOrder) return;
    setSidebarOrder(nextOrder);
    setReorderAnnouncement(t(
      placement === "before" ? "shell.reorderedBefore" : "shell.reorderedAfter",
      { item: dragged.label, target: target.label },
    ));
  }

  function dropSidebarItem(
    event: ReactDragEvent<HTMLElement>,
    target: SidebarDragItem,
    currentItems: readonly SidebarOrderItem[],
  ): void {
    const dragged = draggedSidebarItemRef.current;
    if (!dragged || dragged.containerId !== target.containerId || dragged.itemId === target.itemId) {
      finishSidebarDrag();
      return;
    }
    event.preventDefault();
    const placement = sidebarDropTarget?.containerId === target.containerId
      && sidebarDropTarget.itemId === target.itemId
      ? sidebarDropTarget.placement
      : "before";
    moveSidebarItem(dragged, target, placement, currentItems);
    finishSidebarDrag();
  }

  function moveSidebarItemWithKeyboard(
    event: ReactKeyboardEvent<HTMLElement>,
    item: SidebarDragItem,
    currentItems: readonly SidebarOrderItem[],
  ): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = currentItems.findIndex((candidate) => candidate.itemId === item.itemId);
    const targetIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
    const target = currentItems[targetIndex];
    if (!target) return;
    moveSidebarItem(item, target, event.key === "ArrowUp" ? "before" : "after", currentItems);
  }

  function sidebarDropPosition(containerId: string, itemId: string): "after" | "before" | undefined {
    return sidebarDropTarget?.containerId === containerId && sidebarDropTarget.itemId === itemId
      ? sidebarDropTarget.placement
      : undefined;
  }

  function renderSidebarSessionRows(
    sessionsToRender: readonly SessionSummary[],
    containerId: string,
  ) {
    const orderedSessions = orderSidebarItems(
      sessionsToRender,
      sidebarOrder,
      containerId,
      (session) => session.id,
    );
    const currentItems = orderedSessions.map((session) => ({
      itemId: session.id,
      label: displaySessionTitle(session.title, t),
    }));
    return orderedSessions.map((session, index) => renderSidebarSessionRow(
      session,
      index,
      containerId,
      currentItems,
    ));
  }

  function renderSidebarSessionRow(
    session: SessionSummary,
    index: number,
    containerId: string,
    currentItems: readonly SidebarOrderItem[],
  ) {
    const confirming = confirmingDeleteSessionId === session.id;
    const dissolving = dissolvingSessionIds.has(session.id);
    const sessionLabel = displaySessionTitle(session.title, t);
    const reorderItem = { containerId, itemId: session.id, label: sessionLabel };
    return (
      <div
        className="react-session-row"
        data-active={session.id === activeSessionId}
        data-confirming={confirming}
        data-dragging={draggedSidebarItem?.containerId === containerId && draggedSidebarItem.itemId === session.id
          ? "true"
          : undefined}
        data-drop-position={sidebarDropPosition(containerId, session.id)}
        data-dissolving={dissolving ? "true" : undefined}
        data-motion-role="item"
        draggable={!dissolving}
        key={session.id}
        onDragEnd={finishSidebarDrag}
        onDragOver={(event) => updateSidebarDropTarget(event, reorderItem)}
        onDragStart={(event) => beginSidebarDrag(event, reorderItem)}
        onDrop={(event) => dropSidebarItem(event, reorderItem, currentItems)}
        onMouseLeave={() => actions.onCancelDeleteConfirmation(session.id)}
        style={{ "--react-session-row-index": String(index) } as CSSProperties}
      >
        <button
          aria-description={t("shell.reorderSession", { name: sessionLabel })}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          aria-label={session.title}
          className="react-session-row__select"
          type="button"
          disabled={dissolving}
          onClick={() => actions.onSelectSession(session)}
          onKeyDown={(event) => moveSidebarItemWithKeyboard(event, reorderItem, currentItems)}
        >
          <span className="react-session-row__title">{sessionLabel}</span>
          <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
        </button>
        <button
          aria-label={t(confirming ? "shell.confirmDelete" : "shell.delete", { name: session.title })}
          className="react-session-row__delete"
          data-confirming={confirming}
          draggable={false}
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
        const registered = await workspaceRegistryStore.register(workingDirectory);
        workspaceMutationRevisionRef.current += 1;
        setWorkspaces((current) => upsertWorkspace(current, registered));
        await actions.onCreateSession(registered.path);
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
      const path = await pickDesktopWorkspaceDirectory();
      if (!path) return undefined;
      const registered = await workspaceRegistryStore.register(path);
      workspaceMutationRevisionRef.current += 1;
      setWorkspaces((current) => upsertWorkspace(current, registered));
      return registered.path;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("[session-workspaces] project-workspace.pick.failed", { error: message });
      throw cause;
    } finally {
      setWorkspacePickerPending(false);
    }
  }

  async function handleRenameWorkspace(path: string, name: string): Promise<void> {
    const renamed = await workspaceRegistryStore.rename(path, name);
    workspaceMutationRevisionRef.current += 1;
    setWorkspaces((current) => upsertWorkspace(current, renamed));
  }

  async function handleForgetWorkspace(path: string): Promise<void> {
    await workspaceRegistryStore.forget(path);
    workspaceMutationRevisionRef.current += 1;
    const key = normalizedWorkspacePathKey(path);
    setWorkspaces((current) => current.filter((workspace) => (
      normalizedWorkspacePathKey(workspace.path) !== key
    )));
  }

  function handleCreateCoordinatorSession(project: ProjectGroup): void {
    void actions.onCreateSession(undefined, {
      projectCoordinator: true,
      projectGroupId: project.projectGroupId,
      title: t("projectGroups.newCoordinatorTitle", { name: project.name }),
    });
  }

  function closeSessionSearch(): void {
    restoreSearchTriggerFocusRef.current = true;
    setSearchQuery("");
    setSearchOpen(false);
  }

  return (
    <>
      <aside className="react-session-list" aria-label={t("shell.sessions")} data-collapsed={collapsed}>
        <div className="react-session-list__header">
          <div className="react-session-list__title-row" data-search-open={searchOpen ? "true" : undefined}>
            {searchOpen ? (
              <div aria-label={t("search.label")} className="react-session-list__inline-search" role="search">
                <Search aria-hidden="true" size={15} />
                <input
                  aria-label={t("shell.searchChats")}
                  placeholder={t("search.placeholder")}
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeSessionSearch();
                  }}
                />
                <button
                  aria-label={t("search.close")}
                  className="react-session-list__search-close"
                  title={t("search.close")}
                  type="button"
                  onClick={closeSessionSearch}
                >
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            ) : (
              <>
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
                      <div aria-label={t("shell.workspaceActions")} className="react-popover-surface react-session-list__workspace-menu" role="menu">
                        <button
                          className="react-popover-item"
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
                          className="react-popover-item"
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
                    ref={searchTriggerRef}
                    title={t("shell.searchChats")}
                    type="button"
                    onClick={() => {
                      setWorkspaceActionMenuOpen(false);
                      setSearchOpen(true);
                    }}
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
              </>
            )}
          </div>
          {displayError ? (
            <p className="react-session-list__error" role="alert">{displayError}</p>
          ) : null}
        </div>
        <div className="react-session-list__rows" aria-label={t("shell.sessionRows")} data-motion="animated-list">
          {rootGroups.map((rootGroup) => {
            if (rootGroup.kind === "workspace") {
              const { workspace } = rootGroup;
              const reorderItem = {
                containerId: SIDEBAR_ROOT_CONTAINER_ID,
                itemId: rootGroup.itemId,
                label: rootGroup.label,
              };
              return (
                <div
                  aria-label={t("shell.workspace", { name: workspace.label })}
                  className="react-session-workspace"
                  data-active={workspace.sessions.some((session) => session.id === activeSessionId) ? "true" : undefined}
                  data-dragging={draggedSidebarItem?.containerId === SIDEBAR_ROOT_CONTAINER_ID
                    && draggedSidebarItem.itemId === rootGroup.itemId ? "true" : undefined}
                  data-drop-position={sidebarDropPosition(SIDEBAR_ROOT_CONTAINER_ID, rootGroup.itemId)}
                  key={workspace.key}
                  role="group"
                >
                  <details className="react-session-workspace__details" open>
                    <summary
                      aria-description={t("shell.reorderWorkspace", { name: workspace.label })}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      draggable
                      title={workspace.workingDirectory ?? workspace.label}
                      onDragEnd={finishSidebarDrag}
                      onDragOver={(event) => updateSidebarDropTarget(event, reorderItem)}
                      onDragStart={(event) => beginSidebarDrag(event, reorderItem)}
                      onDrop={(event) => dropSidebarItem(event, reorderItem, rootOrderItems)}
                      onKeyDown={(event) => moveSidebarItemWithKeyboard(event, reorderItem, rootOrderItems)}
                    >
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
                    <div className="react-session-workspace__sessions">
                      {renderSidebarSessionRows(workspace.sessions, sidebarWorkspaceSessionsId(workspace.key))}
                    </div>
                  </details>
                  <div className="react-session-workspace__actions">
                    <button
                      aria-label={t("shell.newSessionIn", { name: workspace.label })}
                      disabled={createPending || !workspace.exists
                        || Boolean(workspace.workingDirectory && !workspace.registered)}
                      title={t("shell.newSessionIn", { name: workspace.label })}
                      type="button"
                      onClick={() => void actions.onCreateSession(workspace.workingDirectory)}
                    >
                      <Plus aria-hidden="true" size={15} />
                    </button>
                    {workspace.registered && workspace.workingDirectory ? (
                      <button
                        aria-label={t("workspaces.manage", { name: workspace.label })}
                        title={t("workspaces.manage", { name: workspace.label })}
                        type="button"
                        onClick={() => setWorkspaceDialogPath(workspace.workingDirectory)}
                      >
                        <MoreHorizontal aria-hidden="true" size={15} />
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            }
            const projectGroup = rootGroup.group;
            const projectSessions = [
              ...projectGroup.coordinatorSessions,
              ...projectGroup.workspaces.flatMap((workspace) => workspace.sessions),
            ];
            const projectWorkspacesContainerId = sidebarProjectWorkspacesId(
              projectGroup.project.projectGroupId,
            );
            const orderedProjectWorkspaces = orderSidebarItems(
              projectGroup.workspaces,
              sidebarOrder,
              projectWorkspacesContainerId,
              (workspace) => sidebarProjectWorkspaceItemId(workspace.workspaceId),
            );
            const projectWorkspaceOrderItems = orderedProjectWorkspaces.map((workspace) => ({
              itemId: sidebarProjectWorkspaceItemId(workspace.workspaceId),
              label: workspace.label,
            }));
            const reorderItem = {
              containerId: SIDEBAR_ROOT_CONTAINER_ID,
              itemId: rootGroup.itemId,
              label: rootGroup.label,
            };
            return (
              <details
                aria-label={t("projectGroups.groupLabel", { name: projectGroup.project.name })}
                className="react-project-group"
                data-active={projectSessions.some((session) => session.id === activeSessionId) ? "true" : undefined}
                data-dragging={draggedSidebarItem?.containerId === SIDEBAR_ROOT_CONTAINER_ID
                  && draggedSidebarItem.itemId === rootGroup.itemId ? "true" : undefined}
                data-drop-position={sidebarDropPosition(SIDEBAR_ROOT_CONTAINER_ID, rootGroup.itemId)}
                key={projectGroup.project.projectGroupId}
                open
                role="group"
              >
                <summary
                  aria-description={t("shell.reorderProject", { name: projectGroup.project.name })}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  draggable
                  title={projectGroup.project.name}
                  onDragEnd={finishSidebarDrag}
                  onDragOver={(event) => updateSidebarDropTarget(event, reorderItem)}
                  onDragStart={(event) => beginSidebarDrag(event, reorderItem)}
                  onDrop={(event) => dropSidebarItem(event, reorderItem, rootOrderItems)}
                  onKeyDown={(event) => moveSidebarItemWithKeyboard(event, reorderItem, rootOrderItems)}
                >
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
                      {renderSidebarSessionRows(
                        projectGroup.coordinatorSessions,
                        sidebarProjectCoordinatorSessionsId(projectGroup.project.projectGroupId),
                      )}
                    </section>
                  ) : null}
                  {orderedProjectWorkspaces.map((workspace) => {
                    const registeredWorkspace = workspaceByKey.get(
                      normalizedWorkspacePathKey(workspace.workspaceId),
                    );
                    const workspaceReorderItem = {
                      containerId: projectWorkspacesContainerId,
                      itemId: sidebarProjectWorkspaceItemId(workspace.workspaceId),
                      label: workspace.label,
                    };
                    return (
                    <section
                      aria-label={t("shell.workspace", { name: workspace.label })}
                      className="react-project-workspace"
                      data-dragging={draggedSidebarItem?.containerId === projectWorkspacesContainerId
                        && draggedSidebarItem.itemId === workspaceReorderItem.itemId ? "true" : undefined}
                      data-drop-position={sidebarDropPosition(
                        projectWorkspacesContainerId,
                        workspaceReorderItem.itemId,
                      )}
                      key={workspace.workspaceId}
                      role="group"
                    >
                      <div
                        aria-description={t("shell.reorderWorkspace", { name: workspace.label })}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        className="react-project-group__member-title"
                        draggable
                        tabIndex={0}
                        title={workspace.workspaceId}
                        onDragEnd={finishSidebarDrag}
                        onDragOver={(event) => updateSidebarDropTarget(event, workspaceReorderItem)}
                        onDragStart={(event) => beginSidebarDrag(event, workspaceReorderItem)}
                        onDrop={(event) => dropSidebarItem(event, workspaceReorderItem, projectWorkspaceOrderItems)}
                        onKeyDown={(event) => {
                          if (event.target === event.currentTarget) {
                            moveSidebarItemWithKeyboard(
                              event,
                              workspaceReorderItem,
                              projectWorkspaceOrderItems,
                            );
                          }
                        }}
                      >
                        <Folder aria-hidden="true" size={13} />
                        <span>
                          <strong>{workspace.label}</strong>
                          <small>{workspace.workspaceId}</small>
                        </span>
                        <button
                          aria-label={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          disabled={createPending || registeredWorkspace?.exists === false}
                          draggable={false}
                          onClick={() => void actions.onCreateSession(workspace.workspaceId, {
                            projectGroupId: projectGroup.project.projectGroupId,
                          })}
                          title={t("projectGroups.newWorkspaceSession", { name: workspace.label })}
                          type="button"
                        >
                          <Plus aria-hidden="true" size={13} />
                        </button>
                        {registeredWorkspace ? (
                          <button
                            aria-label={t("workspaces.manage", { name: workspace.label })}
                            draggable={false}
                            onClick={() => setWorkspaceDialogPath(registeredWorkspace.path)}
                            title={t("workspaces.manage", { name: workspace.label })}
                            type="button"
                          >
                            <MoreHorizontal aria-hidden="true" size={13} />
                          </button>
                        ) : null}
                      </div>
                      <div className="react-project-workspace__sessions">
                        {renderSidebarSessionRows(
                          workspace.sessions,
                          sidebarProjectWorkspaceSessionsId(
                            projectGroup.project.projectGroupId,
                            workspace.workspaceId,
                          ),
                        )}
                      </div>
                    </section>
                    );
                  })}
                </div>
              </details>
            );
          })}
          {!rootGroups.length && !collapsed
            ? <EmptyStateText text={t(normalizedSearchQuery ? "search.noMatches" : "shell.noSessions")} />
            : null}
          <p aria-live="polite" className="react-sr-only">{reorderAnnouncement}</p>
        </div>
      </aside>
      {children}
      {projectDialogGroupId ? (
        <ProjectGroupDialog
          availableWorkspaces={workspaces}
          group={projectDialogGroup}
          onChooseWorkspace={handleChooseProjectWorkspace}
          onClose={() => setProjectDialogGroupId(undefined)}
          onDelete={projectDialogGroup ? handleDeleteProjectGroup : undefined}
          onSave={handleSaveProjectGroup}
        />
      ) : null}
      {workspaceDialogEntry ? (
        <WorkspaceDialog
          workspace={workspaceDialogEntry}
          onClose={() => setWorkspaceDialogPath(undefined)}
          onForget={handleForgetWorkspace}
          onRename={handleRenameWorkspace}
        />
      ) : null}
    </>
  );
}

function WorkspaceDialog({
  onClose,
  onForget,
  onRename,
  workspace,
}: {
  onClose: () => void;
  onForget: (path: string) => Promise<void>;
  onRename: (path: string, name: string) => Promise<void>;
  workspace: WorkspaceRegistryEntry;
}) {
  const { t } = useTranslation("chat");
  const [name, setName] = useState(workspace.name);
  const [pending, setPending] = useState(false);
  const [forgetConfirm, setForgetConfirm] = useState(false);
  const [error, setError] = useState("");
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({
    closeEnabled: !pending,
    onClose,
  });

  async function handleRename(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || nextName === workspace.name || pending) return;
    setPending(true);
    setError("");
    try {
      await onRename(workspace.path, nextName);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }

  async function handleForget() {
    if (pending) return;
    if (!forgetConfirm) {
      setForgetConfirm(true);
      return;
    }
    setPending(true);
    setError("");
    try {
      await onForget(workspace.path);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  }

  return (
    <div className="react-project-dialog-backdrop" onPointerDown={onBackdropPointerDown}>
      <div
        aria-describedby="workspace-dialog-description"
        aria-labelledby="workspace-dialog-title"
        aria-modal="true"
        className="react-project-dialog react-workspace-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2 id="workspace-dialog-title">{t("workspaces.title")}</h2>
            <p id="workspace-dialog-description">{t("workspaces.description")}</p>
          </div>
          <button aria-label={t("workspaces.close")} disabled={pending} onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <form onSubmit={handleRename}>
          <label className="react-project-dialog__name" htmlFor="workspace-name">
            <span>{t("workspaces.name")}</span>
            <input
              aria-label={t("workspaces.name")}
              autoComplete="off"
              data-dialog-initial-focus
              id="workspace-name"
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
            <small>{workspace.path}</small>
          </label>
          {error ? <p className="react-project-dialog__error" role="alert">{error}</p> : null}
          <footer>
            <button
              className="react-project-dialog__delete"
              disabled={pending}
              onClick={() => void handleForget()}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} />
              {forgetConfirm ? t("workspaces.confirmForget") : t("workspaces.forget")}
            </button>
            <div>
              <button disabled={pending} onClick={onClose} type="button">{t("workspaces.cancel")}</button>
              <button disabled={pending || !name.trim() || name.trim() === workspace.name} type="submit">
                {pending ? <Loader2 aria-hidden="true" className="react-session-list__pending" size={14} /> : (
                  <PencilLine aria-hidden="true" size={14} />
                )}
                {t("workspaces.rename")}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}

function EmptyStateText({ text }: { text: string }) {
  return <p className="react-empty-state">{text}</p>;
}

function upsertWorkspace(
  workspaces: WorkspaceRegistryEntry[],
  workspace: WorkspaceRegistryEntry,
): WorkspaceRegistryEntry[] {
  const key = normalizedWorkspacePathKey(workspace.path);
  const index = workspaces.findIndex((candidate) => (
    normalizedWorkspacePathKey(candidate.path) === key
  ));
  if (index < 0) return [...workspaces, workspace];
  const next = [...workspaces];
  next[index] = workspace;
  return next;
}

function sidebarProjectGroupId(projectGroupId: string): string {
  return `project:${encodeURIComponent(projectGroupId)}`;
}

function sidebarWorkspaceGroupId(workspaceKey: string): string {
  return `workspace:${encodeURIComponent(workspaceKey)}`;
}

function sidebarWorkspaceSessionsId(workspaceKey: string): string {
  return `sessions:workspace:${encodeURIComponent(workspaceKey)}`;
}

function sidebarProjectCoordinatorSessionsId(projectGroupId: string): string {
  return `sessions:project:${encodeURIComponent(projectGroupId)}:coordination`;
}

function sidebarProjectWorkspacesId(projectGroupId: string): string {
  return `workspaces:project:${encodeURIComponent(projectGroupId)}`;
}

function sidebarProjectWorkspaceItemId(workspaceId: string): string {
  return normalizedWorkspacePathKey(workspaceId);
}

function sidebarProjectWorkspaceSessionsId(projectGroupId: string, workspaceId: string): string {
  return [
    "sessions:project",
    encodeURIComponent(projectGroupId),
    "workspace",
    encodeURIComponent(normalizedWorkspacePathKey(workspaceId)),
  ].join(":");
}
