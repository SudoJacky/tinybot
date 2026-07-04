import { useEffect, useState } from "react";
import { BookOpen, Bot, Code2, Command, FileText, Folder, MessageSquare, Settings, Wrench, X } from "lucide-react";
import { ChatPage } from "../chat/ChatPage";
import type { AppServices } from "../services";

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
          {route === "chat" ? (
            <ChatPage chatStore={services.chatStore} now={now} sessionStore={services.sessionStore} />
          ) : (
            <PlaceholderPage title={routeItems.find((item) => item.id === route)?.label ?? "Page"} />
          )}
        </section>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="react-placeholder-page">
      <h1>{title}</h1>
      <p>This React placeholder keeps navigation available while the page-specific implementation is rebuilt.</p>
    </div>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  return (
    <div className="react-command-palette-backdrop">
      <section aria-label="Command palette" className="react-command-palette" role="dialog">
        <div>
          <h2>Command palette</h2>
          <button aria-label="Close command palette" type="button" onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <input aria-label="Search commands" autoFocus placeholder="Search commands" />
        <p>Core commands placeholder.</p>
      </section>
    </div>
  );
}
