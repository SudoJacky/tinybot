import { useEffect, useMemo, useState, type DependencyList, type ReactNode } from "react";
import { BookOpen, Bot, Code2, Command, FileText, Folder, MessageSquare, Settings, Wrench, X } from "lucide-react";
import { ChatPage } from "../chat/ChatPage";
import type { AppServices, WorkspaceFileSummary } from "../services";

type AppRoute = "chat" | "files" | "knowledge" | "cowork" | "github" | "docs" | "tools" | "settings";

export type DesktopShellProps = {
  services: AppServices;
  now?: () => number;
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

export function DesktopShell({ now, services }: DesktopShellProps) {
  const [route, setRoute] = useState<AppRoute>("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
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
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="react-desktop-shell">
      <header className="react-window-frame">
        <div className="react-window-frame__brand">Tinybot</div>
        <nav className="react-top-menu" aria-label="Application menu">
          {["App", "Resources", "System", "Help"].map((label) => (
            <button key={label} type="button">{label}</button>
          ))}
        </nav>
        <button aria-label="Open command palette" title="Open command palette" type="button" onClick={() => setPaletteOpen(true)}>
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
          <RouteSurface now={now} route={route} services={services} />
        </section>
      </div>

      {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

function RouteSurface({ now, route, services }: { now?: () => number; route: AppRoute; services: AppServices }) {
  switch (route) {
    case "chat":
      return <ChatPage chatStore={services.chatStore} now={now} sessionStore={services.sessionStore} />;
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
