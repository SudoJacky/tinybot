import { useTranslation } from "react-i18next";
import { useEffect, useState, type ComponentProps } from "react";
import type { DesktopPetPreferences } from "../../app-core/desktop-pet/desktopPetState";
import { ChatPage } from "../chat/ChatPage";
import type { TinybotMascotMood } from "../chat/TinybotMascot";
import type { AppServices } from "../services";
import type { SettingsModuleId } from "../settings/SettingsRoute";
import { DeferredSurface } from "./DeferredSurface";

export type AppRoute = "chat" | "teams" | "automations" | "graphs" | "memory" | "tools" | "settings" | "performanceTrace";

export type SettingsNavigationRequest = {
  moduleId: SettingsModuleId;
  signal: number;
};

type ChatRouteProps = {
  activateSessionRequest?: { sessionId: string; signal: number } | null;
  createSessionSignal: number;
  quickStartRequest?: number | null;
  onQuickStartHandled?: () => void;
  now?: () => number;
  sessionSidebarCollapsed: boolean;
  onActiveWorkspaceChange?: (workingDirectory?: string) => void;
  onSessionSidebarCollapsedChange: (collapsed: boolean) => void;
  onStopGenerationTargetChange: (sessionId: string) => void;
  onMascotMoodChange: (mood: TinybotMascotMood) => void;
  onStartupSessionHydrated?: () => void;
  startInNewSession?: boolean;
};

type DesktopPetRouteProps = {
  preferences: DesktopPetPreferences;
  onPreferencesChange: (preferences: DesktopPetPreferences) => void;
  onResetPosition: () => void;
};

const loadTeamsRoute = () => import("../teams/TeamsRoute");
const loadAutomationsRoute = () => import("../automations/AutomationsRoute");
const loadMemoryRoute = () => import("../memory/MemoryRoute");
const loadAgentGraphsRoute = () => import("../agent-graph/AgentGraphsRoute");
const loadPerformanceTraceRoute = () => import("../performance/PerformanceTraceRoute");
const loadSettingsRoute = () => import("../settings/SettingsRoute");
const loadToolsRoute = () => import("../tools/ToolsRoute");

// Keep the Team workspace alive across shell navigation: drafts and the execution
// promise belong to the workspace, not to the currently visible route.
export function RouteSurface(props: ComponentProps<typeof CurrentRouteSurface>) {
  const { t } = useTranslation("common");
  const [visitedTeams, setVisitedTeams] = useState(props.route === "teams");
  useEffect(() => {
    if (props.route === "teams") setVisitedTeams(true);
  }, [props.route]);
  return (
    <>
      {(visitedTeams || props.route === "teams") && (
        <div hidden={props.route !== "teams"} style={{ height: "100%", minHeight: 0 }}>
          <DeferredSurface
            load={loadTeamsRoute}
            name={t("routes.teams")}
            surfaceProps={{ services: props.services, onOpenThread: props.onOpenThread, onNavigate: props.onNavigate }}
          />
        </div>
      )}
      {props.route !== "teams" && <CurrentRouteSurface {...props} />}
    </>
  );
}

function CurrentRouteSurface({
  chat,
  desktopPet,
  onNavigate,
  onOpenThread,
  route,
  settingsNavigationRequest,
  services,
  workingDirectory,
}: {
  chat: ChatRouteProps;
  desktopPet: DesktopPetRouteProps;
  onNavigate: (route: AppRoute) => void;
  onOpenThread: (threadId: string) => Promise<void>;
  route: AppRoute;
  settingsNavigationRequest?: SettingsNavigationRequest | null;
  services: AppServices;
  workingDirectory?: string;
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
          quickStartRequest={chat.quickStartRequest}
          onQuickStartHandled={chat.onQuickStartHandled}
          now={chat.now}
          projectGroupStore={services.projectGroupStore}
          workspaceRegistryStore={services.workspaceRegistryStore}
          sessionStore={services.sessionStore}
          settingsStore={services.settingsStore}
          toolsStore={services.toolsStore}
          workspaceStore={services.workspaceStore}
          sessionSidebarCollapsed={chat.sessionSidebarCollapsed}
          onActiveWorkspaceChange={chat.onActiveWorkspaceChange}
          onMascotMoodChange={chat.onMascotMoodChange}
          onSessionSidebarCollapsedChange={chat.onSessionSidebarCollapsedChange}
          onOpenTeams={() => onNavigate("teams")}
          onOpenAutomations={() => onNavigate("automations")}
          onStartupSessionHydrated={chat.onStartupSessionHydrated}
          onStopGenerationTargetChange={chat.onStopGenerationTargetChange}
          startInNewSession={chat.startInNewSession}
        />
      );
    case "teams":
      return null;
    case "automations":
      return <DeferredSurface load={loadAutomationsRoute} name={routeName} surfaceProps={{ services, onOpenThread }} />;
    case "graphs":
      return <DeferredSurface load={loadAgentGraphsRoute} name={routeName} surfaceProps={{ services }} />;
    case "memory":
      return <DeferredSurface load={loadMemoryRoute} name={routeName} surfaceProps={{ services }} />;
    case "tools":
      return (
        <DeferredSurface
          load={loadToolsRoute}
          name={routeName}
          surfaceProps={{ services, onOpenChat: () => onNavigate("chat"), workingDirectory }}
        />
      );
    case "settings":
      return (
        <DeferredSurface
          load={loadSettingsRoute}
          name={routeName}
          surfaceProps={{
            activeModuleRequest: settingsNavigationRequest,
            desktopPetPreferences: desktopPet.preferences,
            onDesktopPetPreferencesChange: desktopPet.onPreferencesChange,
            onResetDesktopPetPosition: desktopPet.onResetPosition,
            services,
          }}
        />
      );
    case "performanceTrace":
      return <DeferredSurface load={loadPerformanceTraceRoute} name={routeName} surfaceProps={{ services }} />;
  }
}
