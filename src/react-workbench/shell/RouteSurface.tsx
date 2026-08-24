import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChatPage } from "../chat/ChatPage";
import type { TinybotMascotMood } from "../chat/TinybotMascot";
import type { AppServices, WorkspaceFileSummary } from "../services";
import { DeferredSurface } from "./DeferredSurface";

export type AppRoute = "chat" | "graphs" | "files" | "memory" | "github" | "docs" | "tools" | "settings" | "performanceTrace";

type ChatRouteProps = {
  activateSessionRequest?: { sessionId: string; signal: number } | null;
  createSessionSignal: number;
  now?: () => number;
  sessionSidebarCollapsed: boolean;
  onSessionSidebarCollapsedChange: (collapsed: boolean) => void;
  onStopGenerationTargetChange: (sessionId: string) => void;
  onMascotMoodChange: (mood: TinybotMascotMood) => void;
  onStartupSessionHydrated?: () => void;
  startInNewSession?: boolean;
};

type FilesState =
  | { status: "loading" }
  | { status: "ready"; files: WorkspaceFileSummary[] }
  | { status: "failed"; error: Error };

const loadMemoryRoute = () => import("../memory/MemoryRoute");
const loadAgentGraphsRoute = () => import("../agent-graph/AgentGraphsRoute");
const loadPerformanceTraceRoute = () => import("../performance/PerformanceTraceRoute");
const loadSettingsRoute = () => import("../settings/SettingsRoute");
const loadToolsRoute = () => import("../tools/ToolsRoute");

export function RouteSurface({
  chat,
  onNavigate,
  route,
  services,
}: {
  chat: ChatRouteProps;
  onNavigate: (route: AppRoute) => void;
  route: AppRoute;
  services: AppServices;
}) {
  const { t } = useTranslation("common");
  const routeName = t(`routes.${route}`);

  switch (route) {
    case "chat":
      return (
        <ChatPage
          activateSessionRequest={chat.activateSessionRequest ?? null}
          chatStore={services.chatStore}
          createSessionSignal={chat.createSessionSignal}
          now={chat.now}
          projectGroupStore={services.projectGroupStore}
          sessionStore={services.sessionStore}
          settingsStore={services.settingsStore}
          toolsStore={services.toolsStore}
          workspaceStore={services.workspaceStore}
          sessionSidebarCollapsed={chat.sessionSidebarCollapsed}
          onOpenFiles={() => onNavigate("files")}
          onOpenSettings={() => onNavigate("settings")}
          onMascotMoodChange={chat.onMascotMoodChange}
          onSessionSidebarCollapsedChange={chat.onSessionSidebarCollapsedChange}
          onStartupSessionHydrated={chat.onStartupSessionHydrated}
          onStopGenerationTargetChange={chat.onStopGenerationTargetChange}
          startInNewSession={chat.startInNewSession}
        />
      );
    case "graphs":
      return <DeferredSurface load={loadAgentGraphsRoute} name={routeName} surfaceProps={{ services }} />;
    case "files":
      return <FilesPage services={services} title={routeName} />;
    case "memory":
      return <DeferredSurface load={loadMemoryRoute} name={routeName} surfaceProps={{ services }} />;
    case "tools":
      return (
        <DeferredSurface
          load={loadToolsRoute}
          name={routeName}
          surfaceProps={{ services, onOpenChat: () => onNavigate("chat") }}
        />
      );
    case "settings":
      return <DeferredSurface load={loadSettingsRoute} name={routeName} surfaceProps={{ services }} />;
    case "performanceTrace":
      return <DeferredSurface load={loadPerformanceTraceRoute} name={routeName} surfaceProps={{ services }} />;
    case "github":
    case "docs":
      return <PlaceholderPage title={routeName} />;
  }
}

function FilesPage({ services, title }: { services: AppServices; title: string }) {
  const { t } = useTranslation("common");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<FilesState>({ status: "loading" });
  const workspaceStore = services.workspaceStore;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void workspaceStore.listFiles()
      .then((files) => {
        if (!cancelled) {
          setState({ status: "ready", files });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-files-route]", { attempt: attempt + 1, error });
        setState({ status: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, workspaceStore]);

  return (
    <WorkbenchPage title={title}>
      {state.status === "loading" ? (
        <p aria-live="polite" className="react-empty-state" role="status">
          {t("deferredSurface.loading", { name: title })}
        </p>
      ) : null}
      {state.status === "failed" ? (
        <div className="react-empty-state" role="alert">
          <p>{t("deferredSurface.loadFailed", { message: state.error.message, name: title })}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            {t("deferredSurface.retry", { name: title })}
          </button>
        </div>
      ) : null}
      {state.status === "ready" ? (
        <DataList
          empty={t("files.empty")}
          items={state.files}
          renderItem={(file) => (
            <div className="react-data-row" key={file.path}>
              <strong>{file.path}</strong>
              <small>{formatFileSize(file.size, t("files.sizeUnavailable"))}</small>
            </div>
          )}
        />
      ) : null}
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
  const { t } = useTranslation("common");
  return (
    <div className="react-placeholder-page">
      <h1>{title}</h1>
      <p>{t("placeholder")}</p>
    </div>
  );
}

function formatFileSize(size: WorkspaceFileSummary["size"], unavailable: string): string {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return unavailable;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  return `${(size / 1024).toFixed(1)} KB`;
}
