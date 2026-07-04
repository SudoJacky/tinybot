import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useEffect,
  useMemo,
  useState,
  type DependencyList,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { BookOpen, Bot, Code2, Command, FileText, Folder, MessageSquare, Settings, Wrench, X } from "lucide-react";
import { ChatPage } from "../chat/ChatPage";
import type { AppServices, WorkspaceFileSummary } from "../services";

type AppRoute = "chat" | "files" | "knowledge" | "cowork" | "github" | "docs" | "tools" | "settings";

export type DesktopShellProps = {
  services: AppServices;
  now?: () => number;
  windowControls?: WindowFrameControls;
};

const routeItems: Array<{ id: AppRoute; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "files", label: "Files", icon: Folder },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "cowork", label: "Cowork", icon: Bot },
  { id: "github", label: "GitHub", icon: Code2 },
  { id: "docs", label: "Docs", icon: FileText },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "settings", label: "Settings", icon: Settings },
];

type WindowFrameControls = {
  startDragging(): Promise<void>;
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
  | "open-command-palette"
  | "refresh-gateway-status";

type TopMenuCommand = {
  id: TopMenuCommandId;
  label: string;
  shortcut?: string;
  enabled?: boolean;
};

const topMenuItems: Array<{ label: TopMenuLabel; menuLabel: string; icon: typeof MessageSquare; commands: TopMenuCommand[] }> = [
  {
    label: "App",
    menuLabel: "Application menu",
    icon: Command,
    commands: [
      { id: "new-chat", label: "New Chat", shortcut: "Ctrl+N" },
      { id: "search-sessions", label: "Search Sessions", shortcut: "Ctrl+F", enabled: false },
      { id: "open-command-palette", label: "Command Palette", shortcut: "Ctrl+Shift+P / Ctrl+K" },
      { id: "stop-generation", label: "Stop Generation", shortcut: "Ctrl+.", enabled: false },
      { id: "toggle-theme", label: "Toggle Theme", shortcut: "Ctrl+Shift+T" },
      { id: "toggle-sidebar", label: "Toggle Sidebar", shortcut: "Ctrl+B", enabled: false },
    ],
  },
  {
    label: "Resources",
    menuLabel: "Resources menu",
    icon: Folder,
    commands: [
      { id: "open-chat", label: "Chat" },
    ],
  },
  {
    label: "System",
    menuLabel: "System menu",
    icon: Settings,
    commands: [
      { id: "open-settings", label: "Settings", shortcut: "Ctrl+," },
      { id: "refresh-gateway-status", label: "Gateway Status", shortcut: "Ctrl+Shift+G", enabled: false },
    ],
  },
  {
    label: "Help",
    menuLabel: "Help menu",
    icon: BookOpen,
    commands: [
      { id: "open-docs", label: "Documentation", shortcut: "F1" },
      { id: "open-shortcut-help", label: "Shortcut Help", shortcut: "Ctrl+/", enabled: false },
      { id: "open-page-help", label: "Page Help", shortcut: "Ctrl+Shift+/", enabled: false },
      { id: "open-backend-logs", label: "Backend Logs", enabled: false },
      { id: "open-safe-mode", label: "Open native workbench", enabled: false },
      { id: "open-tinybot-repo", label: "Tinybot repo", enabled: false },
    ],
  },
];

export function DesktopShell({ now, services, windowControls }: DesktopShellProps) {
  const [route, setRoute] = useState<AppRoute>("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activeTopMenu, setActiveTopMenu] = useState<TopMenuLabel | null>(null);
  const [createChatSignal, setCreateChatSignal] = useState(0);
  const frameControls = useMemo(() => windowControls ?? resolveWindowFrameControls(), [windowControls]);
  const commands = useMemo(() => routeItems.map((item) => ({
    id: `open:${item.id}`,
    label: `Open ${item.label}`,
    run: () => {
      setRoute(item.id);
      setPaletteOpen(false);
    },
  })), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setActiveTopMenu(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleFramePointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || isWindowFrameInteractiveTarget(event.target, event.currentTarget)) {
      return;
    }
    void frameControls?.startDragging().catch(logWindowFrameError);
  }

  function handleFrameDoubleClick(event: ReactMouseEvent<HTMLElement>) {
    if (isWindowFrameInteractiveTarget(event.target, event.currentTarget)) {
      return;
    }
    void frameControls?.toggleMaximize().catch(logWindowFrameError);
  }

  function handleTopMenuTrigger(event: ReactMouseEvent<HTMLButtonElement>, label: TopMenuLabel) {
    event.stopPropagation();
    setActiveTopMenu((current) => current === label ? null : label);
  }

  function runTopMenuCommand(command: TopMenuCommand) {
    if (command.enabled === false) {
      return;
    }
    setActiveTopMenu(null);
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
      case "open-command-palette":
        setPaletteOpen(true);
        return;
      case "toggle-theme":
        document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        return;
      default:
        return;
    }
  }

  return (
    <div className="react-desktop-shell">
      <header
        aria-label="Tinybot desktop window frame"
        className="react-window-frame"
        data-tauri-drag-region=""
        role="banner"
        onDoubleClick={handleFrameDoubleClick}
        onPointerDown={handleFramePointerDown}
      >
        <div className="react-window-frame__brand" data-tauri-drag-region="">Tinybot</div>
        <nav className="react-top-menu" aria-label="Application menu">
          {topMenuItems.map(({ commands: menuCommands, icon: Icon, label, menuLabel }) => (
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
                  {menuCommands.map((command) => (
                    <button
                      aria-label={menuCommandAccessibleLabel(command)}
                      className="react-top-menu__menu-item"
                      disabled={command.enabled === false}
                      key={command.id}
                      role="menuitem"
                      title={menuCommandAccessibleLabel(command)}
                      type="button"
                      onClick={() => runTopMenuCommand(command)}
                    >
                      <span className="react-top-menu__menu-label">{command.label}</span>
                      {command.shortcut ? <span className="react-top-menu__shortcut">{command.shortcut}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </nav>
        <div className="react-window-frame__drag-space" data-tauri-drag-region="" />
        <button
          aria-label="Open command palette"
          data-no-window-drag=""
          title="Open command palette"
          type="button"
          onClick={() => setPaletteOpen(true)}
          onDoubleClick={stopWindowFrameEvent}
          onPointerDown={stopWindowFrameEvent}
        >
          <Command aria-hidden="true" size={16} />
        </button>
      </header>

      <div className="react-workbench-layout">
        <nav className="react-activity-rail" aria-label="Primary">
          {routeItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                aria-label={item.label}
                data-active={route === item.id}
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
          <RouteSurface createChatSignal={createChatSignal} now={now} route={route} services={services} />
        </section>
      </div>

      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
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
  route,
  services,
}: {
  createChatSignal: number;
  now?: () => number;
  route: AppRoute;
  services: AppServices;
}) {
  switch (route) {
    case "chat":
      return <ChatPage chatStore={services.chatStore} createSessionSignal={createChatSignal} now={now} sessionStore={services.sessionStore} />;
    case "files":
      return <FilesPage services={services} />;
    case "knowledge":
      return <KnowledgePage services={services} />;
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

function KnowledgePage({ services }: { services: AppServices }) {
  const documents = useAsyncList(() => services.knowledgeStore.listDocuments(), [services]);
  const stats = useAsyncList(() => services.knowledgeStore.stats(), [services]);
  return (
    <WorkbenchPage title="Knowledge">
      <div className="react-stat-strip">
        {stats.length ? stats.map((stat) => (
          <div className="react-stat" key={stat.label}>
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </div>
        )) : <p className="react-empty-state">No knowledge stats available.</p>}
      </div>
      <DataList
        empty="No knowledge documents indexed."
        items={documents}
        renderItem={(document) => (
          <div className="react-data-row" key={document.id}>
            <strong>{document.title}</strong>
            <small>{document.source || document.id}</small>
          </div>
        )}
      />
    </WorkbenchPage>
  );
}

function ToolsPage({ services }: { services: AppServices }) {
  const skills = useAsyncList(() => services.toolsStore.listSkills(), [services]);
  return (
    <WorkbenchPage title="Tools & Skills">
      <DataList
        empty="No skills found."
        items={skills}
        renderItem={(skill) => (
          <div className="react-data-row" key={skill.name}>
            <strong>{skill.name}</strong>
            <small>{skill.description || "Skill"}</small>
          </div>
        )}
      />
    </WorkbenchPage>
  );
}

function SettingsPage({ services }: { services: AppServices }) {
  const settings = useAsyncList(() => services.settingsStore.load(), [services]);
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

function WorkbenchPage({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="react-workbench-page">
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

function CommandPalette({
  commands,
  onClose,
}: {
  commands: Array<{ id: string; label: string; run: () => void }>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filteredCommands = commands.filter((command) => command.label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="react-command-palette-backdrop">
      <section aria-label="Command palette" className="react-command-palette" role="dialog">
        <div>
          <h2>Command palette</h2>
          <button aria-label="Close command palette" type="button" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <input
          aria-label="Search commands"
          autoFocus
          placeholder="Search commands"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="react-command-list">
          {filteredCommands.map((command) => (
            <button key={command.id} type="button" onClick={command.run}>
              {command.label}
            </button>
          ))}
        </div>
      </section>
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

function formatFileSize(size: WorkspaceFileSummary["size"]): string {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return "Size unavailable";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  return `${(size / 1024).toFixed(1)} KB`;
}
