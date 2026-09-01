import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
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
  sessionWorkspaceName,
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
  const [sidebarOrder, setSidebarOrder] = useState<SessionSidebarOrder>(() => (
    typeof window === "undefined"
      ? INITIAL_SESSION_SIDEBAR_ORDER
      : readSessionSidebarOrder(window.localStorage)
  ));
  const [draggedSidebarItem, setDraggedSidebarItem] = useState<SidebarDragItem>();
  const [sidebarDropTarget, setSidebarDropTarget] = useState<SidebarDropTarget>();
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const workspaceActionMenuRef = useRef<HTMLDivElement | null>(null);
  const draggedSidebarItemRef = useRef<SidebarDragItem | undefined>(undefined);

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

  useEffect(() => {
    if (typeof window !== "undefined") {
      writeSessionSidebarOrder(window.localStorage, sidebarOrder);
    }
  }, [sidebarOrder]);

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
  const availableProjectWorkspaceIds = useMemo(() => Array.from(new Set([
    ...sessions.flatMap((session) => session.workingDirectory ? [session.workingDirectory] : []),
    ...projectGroups.flatMap((group) => group.workspaceIds),
  ])), [projectGroups, sessions]);
  const projectDialogGroup = projectDialogGroupId && projectDialogGroupId !== "new"
    ? projectGroups.find((group) => group.projectGroupId === projectDialogGroupId)
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
          {rootGroups.map((rootGroup) => {
            if (rootGroup.kind === "workspace") {
              const { workspace } = rootGroup;
              const reorderItem = {
                containerId: SIDEBAR_ROOT_CONTAINER_ID,
                itemId: rootGroup.itemId,
                label: rootGroup.label,
              };
              return (
                <details
                  aria-label={t("shell.workspace", { name: workspace.label })}
                  className="react-session-workspace"
                  data-active={workspace.sessions.some((session) => session.id === activeSessionId) ? "true" : undefined}
                  data-dragging={draggedSidebarItem?.containerId === SIDEBAR_ROOT_CONTAINER_ID
                    && draggedSidebarItem.itemId === rootGroup.itemId ? "true" : undefined}
                  data-drop-position={sidebarDropPosition(SIDEBAR_ROOT_CONTAINER_ID, rootGroup.itemId)}
                  key={workspace.key}
                  open
                  role="group"
                >
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
                    {renderSidebarSessionRows(workspace.sessions, sidebarWorkspaceSessionsId(workspace.key))}
                  </div>
                </details>
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
                          disabled={createPending}
                          draggable={false}
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
          {!projectProjection.groups.length && !sessionWorkspaces.length && !collapsed
            ? <EmptyStateText text={t("shell.noSessions")} />
            : null}
          <p aria-live="polite" className="react-sr-only">{reorderAnnouncement}</p>
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
