import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DependencyList,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { BookOpen, Bot, ChevronRight, Code2, Command, FileText, Folder, MessageSquare, Minus, Settings, Square, Wrench, X } from "lucide-react";
import { createDesktopStopCommand } from "../../app-core/chat/desktopCommand";
import { ChatPage } from "../chat/ChatPage";
import { AgentDefaultsSettingsPage } from "../settings/AgentDefaultsSettingsPage";
import { ConfigSettingsPage, type ConfigSettingsGroupId } from "../settings/ConfigSettingsPage";
import { ProviderModelsSettingsPage } from "../settings/ProviderModelsSettingsPage";
import type { AppServices, ToolCatalogSummary, WorkspaceFileSummary } from "../services";

type AppRoute = "chat" | "files" | "cowork" | "github" | "docs" | "tools" | "settings";

export type DesktopShellProps = {
  services: AppServices;
  now?: () => number;
  windowControls?: WindowFrameControls;
};

const routeItems: Array<{ id: AppRoute; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "files", label: "Files", icon: Folder },
  { id: "cowork", label: "Cowork", icon: Bot },
  { id: "github", label: "GitHub", icon: Code2 },
  { id: "docs", label: "Docs", icon: FileText },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "settings", label: "Settings", icon: Settings },
];

type WindowFrameControls = {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
};

type TopMenuLabel = "App" | "Resources" | "System" | "Help";

type TopMenuCommandId =
  | "new-chat"
  | "stop-generation"
  | "search-sessions"
  | "open-chat"
  | "open-tinybot-repo"
  | "open-settings"
  | "open-docs"
  | "open-shortcut-help"
  | "open-page-help"
  | "open-backend-logs"
  | "open-safe-mode"
  | "toggle-theme"
  | "toggle-sidebar"
  | "refresh-gateway-status";

type TopMenuCommand = {
  id: TopMenuCommandId;
  label: string;
  shortcut?: string;
  enabled?: boolean;
};

type TopMenuEntry =
  | { kind: "command"; command: TopMenuCommand }
  | { kind: "separator"; id: string }
  | { kind: "submenu"; id: string; label: string; menuLabel: string; commands: TopMenuCommand[]; enabled?: boolean };

type TopMenuItem = {
  label: TopMenuLabel;
  menuLabel: string;
  icon: typeof MessageSquare;
  entries: TopMenuEntry[];
};

const menuCommand = (command: TopMenuCommand): TopMenuEntry => ({ kind: "command", command });
const menuSeparator = (id: string): TopMenuEntry => ({ kind: "separator", id });

const topMenuItems: TopMenuItem[] = [
  {
    label: "App",
    menuLabel: "Application menu",
    icon: Command,
    entries: [
      menuCommand({ id: "new-chat", label: "New Chat", shortcut: "Ctrl+N" }),
      menuCommand({ id: "search-sessions", label: "Search Sessions", shortcut: "Ctrl+F", enabled: false }),
      menuSeparator("app-primary-separator"),
      menuCommand({ id: "stop-generation", label: "Stop Generation", shortcut: "Ctrl+.", enabled: false }),
      menuSeparator("app-view-separator"),
      menuCommand({ id: "toggle-theme", label: "Toggle Theme", shortcut: "Ctrl+Shift+T" }),
      menuCommand({ id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "Ctrl+B" }),
    ],
  },
  {
    label: "Resources",
    menuLabel: "Resources menu",
    icon: Folder,
    entries: [
      menuCommand({ id: "open-chat", label: "Chat" }),
    ],
  },
  {
    label: "System",
    menuLabel: "System menu",
    icon: Settings,
    entries: [
      menuCommand({ id: "open-settings", label: "Settings", shortcut: "Ctrl+," }),
      menuSeparator("system-status-separator"),
      menuCommand({ id: "refresh-gateway-status", label: "Gateway Status", shortcut: "Ctrl+Shift+G", enabled: false }),
    ],
  },
  {
    label: "Help",
    menuLabel: "Help menu",
    icon: BookOpen,
    entries: [
      menuCommand({ id: "open-docs", label: "Documentation", shortcut: "F1" }),
      menuSeparator("help-more-separator"),
      {
        kind: "submenu",
        id: "help-more",
        label: "More",
        menuLabel: "More help options",
        commands: [
          { id: "open-shortcut-help", label: "Shortcut Help", shortcut: "Ctrl+/", enabled: false },
          { id: "open-page-help", label: "Page Help", shortcut: "Ctrl+Shift+/", enabled: false },
          { id: "open-backend-logs", label: "Backend Logs", enabled: false },
          { id: "open-safe-mode", label: "Open native workbench", enabled: false },
          { id: "open-tinybot-repo", label: "Tinybot repo", enabled: false },
        ],
      },
    ],
  },
];

export function DesktopShell({ now, services, windowControls }: DesktopShellProps) {
  const [route, setRoute] = useState<AppRoute>("chat");
  const [activeTopMenu, setActiveTopMenu] = useState<TopMenuLabel | null>(null);
  const [activeTopSubmenu, setActiveTopSubmenu] = useState<string | null>(null);
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false);
  const [createChatSignal, setCreateChatSignal] = useState(0);
  const [stopGenerationSessionId, setStopGenerationSessionId] = useState("");
  const stopGenerationSessionIdRef = useRef("");
  const frameControls = useMemo(() => windowControls ?? resolveWindowFrameControls(), [windowControls]);

  function handleStopGenerationTargetChange(sessionId: string) {
    stopGenerationSessionIdRef.current = sessionId;
    setStopGenerationSessionId(sessionId);
  }

  function stopActiveGeneration() {
    const sessionId = stopGenerationSessionIdRef.current;
    if (sessionId) {
      void services.chatStore.dispatch(createDesktopStopCommand({
        sessionId,
        source: { control: "keyboard-shortcut", surface: "chat" },
      }));
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSessionSidebarCollapsed((collapsed) => !collapsed);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ".") {
        event.preventDefault();
        stopActiveGeneration();
      }
      if (event.key === "Escape") {
        setActiveTopMenu(null);
        setActiveTopSubmenu(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [services.chatStore]);

  useEffect(() => {
    function onWindowPointerDown(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest(".react-top-menu")) {
        return;
      }
      setActiveTopMenu(null);
      setActiveTopSubmenu(null);
    }

    window.addEventListener("pointerdown", onWindowPointerDown);
    return () => window.removeEventListener("pointerdown", onWindowPointerDown);
  }, []);

  function handleFrameDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (isWindowFrameInteractiveTarget(event.target, event.currentTarget)) {
      return;
    }
    void frameControls?.toggleMaximize().catch(logWindowFrameError);
  }

  function runWindowFrameAction(action: "close" | "minimize" | "toggleMaximize") {
    if (!frameControls) {
      return;
    }
    void frameControls[action]().catch(logWindowFrameError);
  }

  function handleTopMenuTrigger(event: ReactMouseEvent<HTMLButtonElement>, label: TopMenuLabel) {
    event.stopPropagation();
    setActiveTopSubmenu(null);
    setActiveTopMenu((current) => current === label ? null : label);
  }

  function runTopMenuCommand(command: TopMenuCommand) {
    if (command.enabled === false) {
      return;
    }
    setActiveTopMenu(null);
    setActiveTopSubmenu(null);
    switch (command.id) {
      case "new-chat":
        setRoute("chat");
        setCreateChatSignal((current) => current + 1);
        return;
      case "open-chat":
        setRoute("chat");
        return;
      case "open-settings":
        setRoute("settings");
        return;
      case "open-docs":
        setRoute("docs");
        return;
      case "stop-generation":
        stopActiveGeneration();
        return;
      case "toggle-theme":
        document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        return;
      case "toggle-sidebar":
        setSessionSidebarCollapsed((collapsed) => !collapsed);
        return;
      default:
        return;
    }
  }

  function renderTopMenuCommand(command: TopMenuCommand) {
    const resolvedCommand = command.id === "stop-generation"
      ? { ...command, enabled: Boolean(stopGenerationSessionId) }
      : command;
    return (
      <button
        aria-label={menuCommandAccessibleLabel(resolvedCommand)}
        className="react-top-menu__menu-item"
        disabled={resolvedCommand.enabled === false}
        key={resolvedCommand.id}
        role="menuitem"
        title={menuCommandAccessibleLabel(resolvedCommand)}
        type="button"
        onClick={() => runTopMenuCommand(resolvedCommand)}
      >
        <span className="react-top-menu__menu-label">{resolvedCommand.label}</span>
        {resolvedCommand.shortcut ? <span className="react-top-menu__shortcut">{resolvedCommand.shortcut}</span> : null}
      </button>
    );
  }

  function renderTopMenuEntry(entry: TopMenuEntry) {
    if (entry.kind === "separator") {
      return <div className="react-top-menu__separator" key={entry.id} role="separator" />;
    }
    if (entry.kind === "command") {
      return renderTopMenuCommand(entry.command);
    }
    const isOpen = activeTopSubmenu === entry.id;
    return (
      <div className="react-top-menu__submenu" key={entry.id}>
        <button
          aria-expanded={isOpen}
          aria-haspopup="menu"
          aria-label={entry.label}
          className="react-top-menu__menu-item react-top-menu__submenu-trigger"
          disabled={entry.enabled === false}
          role="menuitem"
          title={entry.label}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setActiveTopSubmenu(entry.id);
          }}
          onFocus={() => setActiveTopSubmenu(entry.id)}
          onMouseEnter={() => setActiveTopSubmenu(entry.id)}
        >
          <span className="react-top-menu__menu-label">{entry.label}</span>
          <ChevronRight aria-hidden="true" className="react-top-menu__submenu-arrow" size={16} />
        </button>
        {isOpen ? (
          <div
            aria-label={entry.menuLabel}
            className="react-top-menu__submenu-popover"
            role="menu"
            onClick={stopWindowFrameEvent}
            onDoubleClick={stopWindowFrameEvent}
            onPointerDown={stopWindowFrameEvent}
          >
            {entry.commands.map(renderTopMenuCommand)}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="react-desktop-shell">
      <header
        aria-label="Tinybot desktop window frame"
        className="react-window-frame"
        data-tauri-drag-region=""
        role="banner"
        onDoubleClick={handleFrameDoubleClick}
      >
        <div className="react-window-frame__brand" data-tauri-drag-region="">Tinybot</div>
        <nav className="react-top-menu" aria-label="Application menu">
          {topMenuItems.map(({ entries, icon: Icon, label, menuLabel }) => (
            <div className="react-top-menu__group" key={label}>
              <button
                aria-expanded={activeTopMenu === label}
                aria-haspopup="menu"
                aria-label={label}
                className="react-top-menu__trigger"
                data-no-window-drag=""
                title={label}
                type="button"
                onClick={(event) => handleTopMenuTrigger(event, label)}
                onDoubleClick={stopWindowFrameEvent}
                onPointerDown={stopWindowFrameEvent}
              >
                <Icon aria-hidden="true" className="react-top-menu__icon" size={16} />
                <span className="react-top-menu__label">{label}</span>
              </button>
              {activeTopMenu === label ? (
                <div
                  aria-label={menuLabel}
                  className="react-top-menu__popover"
                  role="menu"
                  onClick={stopWindowFrameEvent}
                  onDoubleClick={stopWindowFrameEvent}
                  onPointerDown={stopWindowFrameEvent}
                >
                  {entries.map(renderTopMenuEntry)}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
        <div className="react-window-frame__drag-space" data-tauri-drag-region="" />
        <div
          aria-label="Window controls"
          className="react-window-frame__controls"
          data-no-window-drag=""
          role="group"
          onDoubleClick={stopWindowFrameEvent}
          onPointerDown={stopWindowFrameEvent}
        >
          <button
            aria-label="Minimize window"
            className="react-window-frame__control"
            title="Minimize"
            type="button"
            onClick={() => runWindowFrameAction("minimize")}
          >
            <Minus aria-hidden="true" size={14} />
          </button>
          <button
            aria-label="Maximize window"
            className="react-window-frame__control"
            title="Maximize"
            type="button"
            onClick={() => runWindowFrameAction("toggleMaximize")}
          >
            <Square aria-hidden="true" size={12} />
          </button>
          <button
            aria-label="Close window"
            className="react-window-frame__control react-window-frame__control--close"
            title="Close"
            type="button"
            onClick={() => runWindowFrameAction("close")}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      <div className="react-workbench-layout">
        <nav className="react-activity-rail" aria-label="Primary">
          {routeItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-label={item.label}
                data-active={route === item.id}
                data-label={item.label}
                key={item.id}
                title={item.label}
                type="button"
                onClick={() => setRoute(item.id)}
              >
                <Icon aria-hidden="true" size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <section className="react-route-surface">
          <RouteSurface
            createChatSignal={createChatSignal}
            now={now}
          route={route}
          services={services}
          sessionSidebarCollapsed={sessionSidebarCollapsed}
          onNavigate={setRoute}
          onSessionSidebarCollapsedChange={setSessionSidebarCollapsed}
          onStopGenerationTargetChange={handleStopGenerationTargetChange}
        />
        </section>
      </div>

    </div>
  );
}

function resolveWindowFrameControls(): WindowFrameControls | null {
  if (!hasTauriRuntime()) {
    return null;
  }
  return getCurrentWindow();
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function isWindowFrameInteractiveTarget(target: EventTarget, currentTarget: HTMLElement): boolean {
  if (!(target instanceof Element) || !currentTarget.contains(target)) {
    return false;
  }
  return Boolean(target.closest("button, a, input, textarea, select, [role='button'], [data-no-window-drag]"));
}

function stopWindowFrameEvent(event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function logWindowFrameError(error: unknown): void {
  console.warn("Tinybot React window frame action failed", error);
}

function menuCommandAccessibleLabel(command: TopMenuCommand): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}

function RouteSurface({
  createChatSignal,
  now,
  onNavigate,
  onSessionSidebarCollapsedChange,
  onStopGenerationTargetChange,
  route,
  services,
  sessionSidebarCollapsed,
}: {
  createChatSignal: number;
  now?: () => number;
  onNavigate: (route: AppRoute) => void;
  onSessionSidebarCollapsedChange: (collapsed: boolean) => void;
  onStopGenerationTargetChange: (sessionId: string) => void;
  route: AppRoute;
  services: AppServices;
  sessionSidebarCollapsed: boolean;
}) {
  switch (route) {
    case "chat":
      return (
        <ChatPage
          chatStore={services.chatStore}
          createSessionSignal={createChatSignal}
          now={now}
          sessionStore={services.sessionStore}
          settingsStore={services.settingsStore}
          workspaceStore={services.workspaceStore}
          sessionSidebarCollapsed={sessionSidebarCollapsed}
          onOpenFiles={() => onNavigate("files")}
          onOpenSettings={() => onNavigate("settings")}
          onSessionSidebarCollapsedChange={onSessionSidebarCollapsedChange}
          onStopGenerationTargetChange={onStopGenerationTargetChange}
        />
      );
    case "files":
      return <FilesPage services={services} />;
    case "tools":
      return <ToolsPage services={services} />;
    case "settings":
      return <SettingsPage services={services} />;
    case "cowork":
    case "github":
    case "docs":
      return <PlaceholderPage title={routeItems.find((item) => item.id === route)?.label ?? "Page"} />;
  }
}

function FilesPage({ services }: { services: AppServices }) {
  const files = useAsyncList(() => services.workspaceStore.listFiles(), [services]);
  return (
    <WorkbenchPage title="Workspace Files">
      <DataList
        empty="No workspace files found."
        items={files}
        renderItem={(file) => (
          <div className="react-data-row" key={file.path}>
            <strong>{file.path}</strong>
            <small>{formatFileSize(file.size)}</small>
          </div>
        )}
      />
    </WorkbenchPage>
  );
}

function ToolsPage({ services }: { services: AppServices }) {
  const catalog = useAsyncValue<ToolCatalogSummary>(
    () => services.toolsStore.loadCatalog(),
    { tools: [], mcpServers: [] },
    [services],
  );
  const skills = useAsyncList(() => services.toolsStore.listSkills(), [services]);
  return (
    <WorkbenchPage title="Tools & Skills">
      <div className="react-tools-skills-page">
        <section>
          <h2>Tools</h2>
          <DataList
            empty="No tools found."
            items={catalog.tools}
            renderItem={(tool) => (
              <div className="react-data-row" key={tool.id}>
                <span className="react-data-row__content">
                  <strong>{tool.displayName}</strong>
                  <small>{tool.description || tool.name}</small>
                </span>
                <small>{toolMeta(tool)}</small>
              </div>
            )}
          />
        </section>
        {catalog.mcpServers.length > 0 ? (
          <section>
            <h2>MCP servers</h2>
            <DataList
              empty="No MCP servers configured."
              items={catalog.mcpServers}
              renderItem={(server) => (
                <div className="react-data-row" key={server.id}>
                  <span className="react-data-row__content">
                    <strong>{server.id}</strong>
                    <small>{server.error || `${server.transport} transport`}</small>
                  </span>
                  <small>{server.state} / {server.toolCount} tools</small>
                </div>
              )}
            />
          </section>
        ) : null}
        <section>
          <h2>Skills</h2>
          <DataList
            empty="No skills found."
            items={skills}
            renderItem={(skill) => (
              <div className="react-data-row" key={skill.name}>
                <span className="react-data-row__content">
                  <strong>{skill.name}</strong>
                  <small>{skill.description || "Skill"}</small>
                </span>
                <small>{skillMeta(skill)}</small>
              </div>
            )}
          />
        </section>
      </div>
    </WorkbenchPage>
  );
}

function toolMeta(tool: ToolCatalogSummary["tools"][number]): string {
  const source = tool.serverId ? `MCP: ${tool.serverId}` : tool.source;
  const status = !tool.available ? tool.reason || "unavailable" : !tool.enabled ? tool.reason || "disabled" : "available";
  return [source, status, tool.approvalRequired ? "approval required" : ""].filter(Boolean).join(" / ");
}

function skillMeta(skill: Awaited<ReturnType<AppServices["toolsStore"]["listSkills"]>>[number]): string {
  const status = skill.available === false
    ? skill.reason || "unavailable"
    : skill.enabled === false
      ? skill.reason || "disabled"
      : skill.effective
        ? "active"
        : skill.always
          ? "autoload"
          : "available";
  return [skill.source || "skill", status].join(" / ");
}

function SettingsPage({ services }: { services: AppServices }) {
  const settings = useAsyncList(() => services.settingsStore.load(), [services]);
  const [activeSettingsModuleId, setActiveSettingsModuleId] = useState<SettingsModuleId>("provider-models");
  if (services.settingsStore.loadProviderSettings && services.settingsStore.saveProviderSettings) {
    const availableModules = settingsModules.filter((module) => {
      if (module.id === "agent-defaults") {
        return Boolean(services.settingsStore.loadAgentDefaultsSettings && services.settingsStore.saveAgentDefaultsSettings);
      }
      if (module.groupId) {
        return Boolean(services.settingsStore.loadDesktopConfigSettings && services.settingsStore.saveDesktopConfigSettings);
      }
      return true;
    });
    const activeModuleId = availableModules.some((module) => module.id === activeSettingsModuleId)
      ? activeSettingsModuleId
      : "provider-models";
    return (
      <WorkbenchPage title="Settings">
        <SettingsLayout
          activeModuleId={activeModuleId}
          modules={availableModules}
          onSelectModule={setActiveSettingsModuleId}
        >
          {activeModuleId === "agent-defaults" ? (
            <AgentDefaultsSettingsPage
              onNavigateToProviderModels={() => setActiveSettingsModuleId("provider-models")}
              settingsStore={services.settingsStore}
            />
          ) : activeModuleId !== "provider-models" ? (
            <ConfigSettingsPage
              groupId={activeModuleId}
              settingsStore={services.settingsStore}
            />
          ) : (
            <ProviderModelsSettingsPage settingsStore={services.settingsStore} />
          )}
        </SettingsLayout>
      </WorkbenchPage>
    );
  }
  return (
    <WorkbenchPage title="Settings">
      <DataList
        empty="No settings summary available."
        items={settings}
        renderItem={(setting) => (
          <div className="react-data-row" key={setting.label}>
            <strong>{setting.label}</strong>
            <small>{setting.value}</small>
          </div>
        )}
      />
    </WorkbenchPage>
  );
}

type SettingsModuleId = "provider-models" | "agent-defaults" | ConfigSettingsGroupId;

const settingsModules: Array<{ id: SettingsModuleId; label: string; description: string; groupId?: ConfigSettingsGroupId }> = [
  { id: "provider-models", label: "Provider & Models", description: "Providers, API keys, and model defaults" },
  { id: "agent-defaults", label: "Agent Defaults", description: "Runtime behavior for new agent turns" },
  { id: "tools-approvals", label: "Tools & MCP", description: "Tool access and MCP server configuration", groupId: "tools-approvals" },
  { id: "channels", label: "Channels", description: "Progress signals and delivery retries", groupId: "channels" },
  { id: "gateway-runtime", label: "Gateway & Runtime", description: "Local port and heartbeat behavior", groupId: "gateway-runtime" },
];

function SettingsLayout({
  activeModuleId,
  children,
  modules,
  onSelectModule,
}: {
  activeModuleId: SettingsModuleId;
  children: ReactNode;
  modules: Array<{ id: SettingsModuleId; label: string; description: string }>;
  onSelectModule: (moduleId: SettingsModuleId) => void;
}) {
  return (
    <div className="react-settings-layout">
      <aside className="react-settings-sidebar">
        <nav aria-label="Settings categories">
          {modules.map((module) => (
            <button
              key={module.id}
              aria-current={module.id === activeModuleId ? "page" : undefined}
              aria-label={module.label}
              onClick={() => onSelectModule(module.id)}
              type="button"
            >
              <span>{module.label}</span>
              <small>{module.description}</small>
            </button>
          ))}
        </nav>
      </aside>
      <div className="react-settings-detail">
        {children}
      </div>
    </div>
  );
}

function WorkbenchPage({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className={title === "Settings" ? "react-workbench-page react-workbench-page--settings" : "react-workbench-page"}>
      <header>
        <h1>{title}</h1>
      </header>
      {children}
    </div>
  );
}

function DataList<T>({ empty, items, renderItem }: {
  empty: string;
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  if (!items.length) {
    return <p className="react-empty-state">{empty}</p>;
  }
  return <div className="react-data-list">{items.map(renderItem)}</div>;
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="react-placeholder-page">
      <h1>{title}</h1>
      <p>This React placeholder keeps navigation available while the page-specific implementation is rebuilt.</p>
    </div>
  );
}

function useAsyncList<T>(load: () => Promise<T[]>, deps: DependencyList): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    let cancelled = false;
    void load().then((nextItems) => {
      if (!cancelled) {
        setItems(nextItems);
      }
    }).catch(() => {
      if (!cancelled) {
        setItems([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, deps);
  return items;
}

function useAsyncValue<T>(load: () => Promise<T>, initialValue: T, deps: DependencyList): T {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    let cancelled = false;
    void load().then((nextValue) => {
      if (!cancelled) {
        setValue(nextValue);
      }
    }).catch(() => {
      if (!cancelled) {
        setValue(initialValue);
      }
    });
    return () => {
      cancelled = true;
    };
  }, deps);
  return value;
}

function formatFileSize(size: WorkspaceFileSummary["size"]): string {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return "Size unavailable";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  return `${(size / 1024).toFixed(1)} KB`;
}
