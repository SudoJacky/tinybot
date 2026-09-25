import { useTranslation } from "react-i18next";
import type { ComponentProps } from "react";
import type { DesktopPetPreferences } from "../../app-core/desktop-pet/desktopPetState";
import { ChatPage } from "../chat/ChatPage";
import type { TinybotMascotMood } from "../chat/TinybotMascot";
import type { AppServices } from "../services";
import type { SettingsModuleId } from "../settings/SettingsRoute";
import { DeferredSurface } from "./DeferredSurface";
import { resolveAppRoute, type ActiveAppRoute, type AppRoute } from "./appRoutes";

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

const loadAutomationsRoute = () => import("../automations/AutomationsRoute");
const loadMemoryRoute = () => import("../memory/MemoryRoute");
const loadAgentGraphsRoute = () => import("../agent-graph/AgentGraphsRoute");
const loadPerformanceTraceRoute = () => import("../performance/PerformanceTraceRoute");
const loadSettingsRoute = () => import("../settings/SettingsRoute");
const loadToolsRoute = () => import("../tools/ToolsRoute");

export function RouteSurface(props: Omit<ComponentProps<typeof CurrentRouteSurface>, "route"> & { route: AppRoute }) {
  return <CurrentRouteSurface {...props} route={resolveAppRoute(props.route)} />;
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
  route: ActiveAppRoute;
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
          onOpenAutomations={() => onNavigate("automations")}
          onStartupSessionHydrated={chat.onStartupSessionHydrated}
          onStopGenerationTargetChange={chat.onStopGenerationTargetChange}
          startInNewSession={chat.startInNewSession}
        />
      );
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
