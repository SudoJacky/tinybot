import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Command,
  ExternalLink,
  Folder,
  Minus,
  Settings,
  Square,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { createDesktopStopCommand } from "../../app-core/chat/desktopCommand";
import {
  findShortcutCommand,
  isShortcutCommandId,
  type ShortcutCommandId,
  type ShortcutPreferences,
} from "../../app-core/settings/appShortcuts";
import { createDesktopNativeShortcutClient } from "../../app-core/native/desktopNativeShortcuts";
import { AppAppearanceProvider, useAppAppearance } from "../settings/AppAppearanceContext";
import { AppLanguageProvider } from "../settings/AppLanguageContext";
import { AppShortcutProvider, useAppShortcuts } from "../settings/AppShortcutContext";
import type { AppServices } from "../services";
import type { DesktopUpdateClient } from "../../app-core/native/desktopNativeUpdate";
import { DesktopUpdateDialogs } from "./DesktopUpdateDialogs";
import { DesktopPet } from "./DesktopPet";
import {
  readDesktopPetPreferences,
  writeDesktopPetPreferences,
  type DesktopPetPosition,
  type DesktopPetPreferences,
} from "../../app-core/desktop-pet/desktopPetState";
import { RouteSurface, type AppRoute, type SettingsNavigationRequest } from "./RouteSurface";
import type { TinybotMascotMood } from "../chat/TinybotMascot";

type RouteHistory = {
  back: AppRoute[];
  current: AppRoute;
  forward: AppRoute[];
};

export type DesktopShellProps = {
  services: AppServices;
  now?: () => number;
  updateClient?: DesktopUpdateClient | null;
  windowControls?: WindowFrameControls;
};

type WindowFrameControls = {
  close(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
};

type TopMenuLabel = string;
type MotionSource = "keyboard" | "pointer";

const TINYBOT_GITHUB_URL = "https://github.com/SudoJacky/tinybot";
const TINYBOT_DOCUMENTATION_URL = `${TINYBOT_GITHUB_URL}#readme`;
const TINYBOT_NEW_ISSUE_URL = `${TINYBOT_GITHUB_URL}/issues/new/choose`;

type TopMenuCommandId =
  | "new-chat"
  | "stop-generation"
  | "search-sessions"
  | "open-chat"
  | "open-graphs"
  | "open-memory"
  | "open-tools"
  | "open-tinybot-repo"
  | "open-settings"
  | "open-whats-new"
  | "open-performance-trace"
  | "open-docs"
  | "open-shortcut-help"
  | "open-report-issue"
  | "open-about"
  | "toggle-theme"
  | "toggle-sidebar";

type TopMenuCommand = {
  id: TopMenuCommandId;
  label: string;
  shortcut?: string;
  enabled?: boolean;
  externalUrl?: string;
  route?: AppRoute;
  settingsModule?: SettingsNavigationRequest["moduleId"];
};

type TopMenuEntry =
  | { kind: "command"; command: TopMenuCommand }
  | { kind: "separator"; id: string };

type TopMenuItem = {
  label: TopMenuLabel;
  menuLabel: string;
  icon: typeof Command;
  entries: TopMenuEntry[];
};

const menuCommand = (command: TopMenuCommand): TopMenuEntry => ({ kind: "command", command });
const menuSeparator = (id: string): TopMenuEntry => ({ kind: "separator", id });

function createRouteLabels(t: TFunction<"common">): Record<AppRoute, string> {
  return {
    chat: t("routes.chat"),
    graphs: t("routes.graphs"),
    memory: t("routes.memory"),
    tools: t("routes.tools"),
    settings: t("routes.settings"),
    performanceTrace: t("routes.performanceTrace"),
  };
}

function createTopMenuItems(
  t: TFunction<"common">,
  routeLabels: Record<AppRoute, string>,
  shortcuts: ShortcutPreferences,
): TopMenuItem[] {
  return [
  {
    label: t("menu.app"),
    menuLabel: t("menu.applicationLabel"),
    icon: Command,
    entries: [
      menuCommand({ id: "new-chat", label: t("menu.newChat"), shortcut: shortcuts["new-chat"] ?? undefined }),
      menuCommand({ id: "search-sessions", label: t("menu.searchSessions"), shortcut: "Ctrl+F", enabled: false }),
      menuSeparator("app-primary-separator"),
      menuCommand({ id: "stop-generation", label: t("menu.stopGeneration"), shortcut: shortcuts["stop-generation"] ?? undefined, enabled: false }),
      menuSeparator("app-view-separator"),
      menuCommand({ id: "toggle-theme", label: t("menu.toggleTheme"), shortcut: shortcuts["toggle-theme"] ?? undefined }),
      menuCommand({ id: "toggle-sidebar", label: t("menu.toggleSidebar"), shortcut: shortcuts["toggle-sidebar"] ?? undefined }),
      menuSeparator("app-about-separator"),
      menuCommand({ id: "open-about", label: t("menu.about") }),
    ],
  },
  {
    label: t("menu.resources"),
    menuLabel: t("menu.resourcesLabel"),
    icon: Folder,
    entries: [
      menuCommand({ id: "open-chat", label: routeLabels.chat, route: "chat" }),
      menuCommand({ id: "open-graphs", label: routeLabels.graphs, route: "graphs" }),
      menuCommand({ id: "open-memory", label: routeLabels.memory, route: "memory" }),
      menuCommand({ id: "open-tools", label: routeLabels.tools, route: "tools" }),
    ],
  },
  {
    label: t("menu.system"),
    menuLabel: t("menu.systemLabel"),
    icon: Settings,
    entries: [
      menuCommand({ id: "open-settings", label: routeLabels.settings, route: "settings", shortcut: shortcuts["open-settings"] ?? undefined }),
      menuCommand({ id: "open-whats-new", label: t("menu.whatsNew") }),
      menuSeparator("system-observability-separator"),
      menuCommand({ id: "open-performance-trace", label: routeLabels.performanceTrace, route: "performanceTrace" }),
    ],
  },
  {
    label: t("menu.help"),
    menuLabel: t("menu.helpLabel"),
    icon: BookOpen,
    entries: [
      menuCommand({ id: "open-docs", label: t("menu.documentation"), externalUrl: TINYBOT_DOCUMENTATION_URL, shortcut: shortcuts["open-docs"] ?? undefined }),
      menuCommand({ id: "open-shortcut-help", label: t("menu.shortcutHelp"), settingsModule: "keyboard-shortcuts" }),
      menuSeparator("help-community-separator"),
      menuCommand({ id: "open-report-issue", label: t("menu.reportIssue"), externalUrl: TINYBOT_NEW_ISSUE_URL }),
      menuCommand({ id: "open-tinybot-repo", label: t("menu.tinybotRepo"), externalUrl: TINYBOT_GITHUB_URL }),
    ],
  },
  ];
}

export function DesktopShell(props: DesktopShellProps) {
  return (
    <AppLanguageProvider>
      <AppAppearanceProvider>
        <AppShortcutProvider>
          <DesktopShellContent {...props} />
        </AppShortcutProvider>
      </AppAppearanceProvider>
    </AppLanguageProvider>
  );
}

function DesktopShellContent({ now, services, updateClient, windowControls }: DesktopShellProps) {
  const { t } = useTranslation("common");
  const { toggleTheme } = useAppAppearance();
  const { preferences: shortcuts } = useAppShortcuts();
  const routeLabels = createRouteLabels(t);
  const [routeHistory, setRouteHistory] = useState<RouteHistory>({
    back: [],
    current: "chat",
    forward: [],
  });
  const route = routeHistory.current;
  const [activeTopMenu, setActiveTopMenu] = useState<TopMenuLabel | null>(null);
  const [menuMotionSource, setMenuMotionSource] = useState<MotionSource>("pointer");
  const [settingsNavigationRequest, setSettingsNavigationRequest] = useState<SettingsNavigationRequest | null>(null);
  const [sessionSidebarCollapsed, setSessionSidebarCollapsed] = useState(false);
  const [sidebarMotionSource, setSidebarMotionSource] = useState<MotionSource>("pointer");
  const [createChatSignal, setCreateChatSignal] = useState(0);
  const [activateChatSessionRequest, setActivateChatSessionRequest] = useState<{
    sessionId: string;
    signal: number;
  } | null>(null);
  const [aboutOpenSignal, setAboutOpenSignal] = useState(0);
  const [whatsNewOpenSignal, setWhatsNewOpenSignal] = useState(0);
  const [stopGenerationSessionId, setStopGenerationSessionId] = useState("");
  const [activeWorkspaceDirectory, setActiveWorkspaceDirectory] = useState<string>();
  const [desktopPetMood, setDesktopPetMood] = useState<TinybotMascotMood>("calm");
  const [desktopPetResetPositionSignal, setDesktopPetResetPositionSignal] = useState(0);
  const [desktopPetPreferences, setDesktopPetPreferences] = useState<DesktopPetPreferences>(
    () => readDesktopPetPreferences(window.localStorage),
  );
  const desktopPetHost = services.desktopPetHost ?? null;
  const desktopPetQuickChatHost = services.desktopPetQuickChatHost ?? null;
  const desktopPetLabel = t(`desktopPet.status.${desktopPetMood}`);
  const [startChatInNewSession, setStartChatInNewSession] = useState(true);
  const stopGenerationSessionIdRef = useRef("");
  const frameControls = useMemo(() => windowControls ?? resolveWindowFrameControls(), [windowControls]);
  const topMenuItems = createTopMenuItems(t, routeLabels, shortcuts);
  const handleStartupSessionHydrated = useCallback(() => {
    setStartChatInNewSession(false);
  }, []);

  const updateDesktopPetPreferences = useCallback((
    update: DesktopPetPreferences | ((current: DesktopPetPreferences) => DesktopPetPreferences),
  ) => {
    setDesktopPetPreferences((current) => {
      const preferences = typeof update === "function" ? update(current) : update;
      if (sameDesktopPetPreferences(current, preferences)) {
        return current;
      }
      writeDesktopPetPreferences(window.localStorage, preferences);
      return preferences;
    });
  }, []);

  const resetDesktopPetPosition = useCallback(() => {
    const preferences = { ...desktopPetPreferences, position: null };
    updateDesktopPetPreferences(preferences);
    setDesktopPetResetPositionSignal((current) => current + 1);
    if (desktopPetHost) {
      void desktopPetHost.resetPosition({
        label: desktopPetLabel,
        mood: desktopPetMood,
        preferences,
      }).catch((error) => {
        console.error("[desktop-pet] Failed to reset the native pet position.", error);
      });
    }
  }, [desktopPetHost, desktopPetLabel, desktopPetMood, desktopPetPreferences, updateDesktopPetPreferences]);

  useEffect(() => {
    if (!desktopPetHost) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void desktopPetHost.listen((patch) => {
      updateDesktopPetPreferences((current) => ({ ...current, ...patch }));
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    }).catch((error) => {
      console.error("[desktop-pet] Failed to listen to the native pet window.", error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopPetHost, updateDesktopPetPreferences]);

  useEffect(() => {
    if (!desktopPetHost) {
      return;
    }
    void desktopPetHost.sync({
      label: desktopPetLabel,
      mood: desktopPetMood,
      preferences: desktopPetPreferences,
    }).catch((error) => {
      console.error("[desktop-pet] Failed to synchronize the native pet window.", error);
    });
  }, [desktopPetHost, desktopPetLabel, desktopPetMood, desktopPetPreferences]);

  function handleStopGenerationTargetChange(sessionId: string) {
    stopGenerationSessionIdRef.current = sessionId;
    setStopGenerationSessionId(sessionId);
  }

  const stopActiveGeneration = useCallback(() => {
    const sessionId = stopGenerationSessionIdRef.current;
    if (sessionId) {
      void services.chatStore.dispatch(createDesktopStopCommand({
        sessionId,
        source: { control: "keyboard-shortcut", surface: "chat" },
      }));
    }
  }, [services.chatStore]);

  const navigateToRoute = useCallback((nextRoute: AppRoute) => {
    setRouteHistory((current) => {
      if (nextRoute === current.current) {
        return current;
      }
      return {
        back: [...current.back, current.current],
        current: nextRoute,
        forward: [],
      };
    });
  }, []);

  useEffect(() => {
    if (!desktopPetQuickChatHost) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void desktopPetQuickChatHost.listen((event) => {
      if (disposed || event.type !== "open-main") return;
      navigateToRoute("chat");
      if (event.sessionId) {
        const sessionId = event.sessionId;
        setActivateChatSessionRequest((current) => ({
          sessionId,
          signal: (current?.signal ?? 0) + 1,
        }));
      }
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((error) => {
      console.error("[desktop-pet-quick-chat] Failed to listen for panel actions.", error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopPetQuickChatHost, navigateToRoute]);

  const executeShortcutCommand = useCallback((commandId: ShortcutCommandId, source: MotionSource) => {
    switch (commandId) {
      case "new-chat":
        navigateToRoute("chat");
        setCreateChatSignal((current) => current + 1);
        break;
      case "stop-generation":
        stopActiveGeneration();
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "toggle-sidebar":
        setSidebarMotionSource(source);
        setSessionSidebarCollapsed((collapsed) => !collapsed);
        break;
      case "open-settings":
        navigateToRoute("settings");
        break;
      case "open-docs":
        openExternalMenuUrl(TINYBOT_DOCUMENTATION_URL);
        break;
    }
  }, [navigateToRoute, stopActiveGeneration, toggleTheme]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || (
        event.target instanceof Element && event.target.closest("[data-shortcut-recorder]")
      )) {
        return;
      }
      const commandId = findShortcutCommand(shortcuts, event);
      if (commandId) {
        event.preventDefault();
        executeShortcutCommand(commandId, "keyboard");
      }
      if (event.key === "Escape") {
        setActiveTopMenu(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [executeShortcutCommand, shortcuts]);

  useEffect(() => {
    const nativeClient = createDesktopNativeShortcutClient();
    if (!nativeClient) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void nativeClient.listen((commandId) => {
      if (isShortcutCommandId(commandId)) {
        executeShortcutCommand(commandId, "keyboard");
      }
    }).then((stopListening) => {
      if (disposed) {
        stopListening();
      } else {
        unlisten = stopListening;
      }
    }).catch((error) => {
      console.error("[tinybot-shortcuts] Failed to listen for native menu commands.", error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [executeShortcutCommand]);

  useEffect(() => {
    function onWindowPointerDown(event: PointerEvent) {
      if (event.target instanceof Element && event.target.closest(".react-top-menu")) {
        return;
      }
      setActiveTopMenu(null);
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
    setMenuMotionSource(event.detail === 0 ? "keyboard" : "pointer");
    setActiveTopMenu((current) => current === label ? null : label);
  }

  function goBack() {
    setRouteHistory((current) => {
      const previous = current.back[current.back.length - 1];
      if (!previous) {
        return current;
      }
      return {
        back: current.back.slice(0, -1),
        current: previous,
        forward: [current.current, ...current.forward],
      };
    });
  }

  function goForward() {
    setRouteHistory((current) => {
      const [next, ...remaining] = current.forward;
      if (!next) {
        return current;
      }
      return {
        back: [...current.back, current.current],
        current: next,
        forward: remaining,
      };
    });
  }

  function runTopMenuCommand(command: TopMenuCommand, source: MotionSource) {
    if (command.enabled === false) {
      return;
    }
    setActiveTopMenu(null);
    if (command.settingsModule) {
      const moduleId = command.settingsModule;
      setSettingsNavigationRequest((current) => ({
        moduleId,
        signal: (current?.signal ?? 0) + 1,
      }));
      navigateToRoute("settings");
      return;
    }
    if (command.externalUrl) {
      openExternalMenuUrl(command.externalUrl);
      return;
    }
    if (command.route) {
      navigateToRoute(command.route);
      return;
    }
    if (isShortcutCommandId(command.id)) {
      executeShortcutCommand(command.id, source);
      return;
    }
    switch (command.id) {
      case "open-about":
        setAboutOpenSignal((current) => current + 1);
        return;
      case "open-whats-new":
        setWhatsNewOpenSignal((current) => current + 1);
        return;
      default:
        return;
    }
  }

  function renderTopMenuCommand(command: TopMenuCommand) {
    const resolvedCommand = command.id === "stop-generation"
      ? { ...command, enabled: Boolean(stopGenerationSessionId) }
      : command;
    const accessibleLabel = menuCommandAccessibleLabel(resolvedCommand);
    return (
      <button
        aria-current={resolvedCommand.route === route ? "page" : undefined}
        aria-label={accessibleLabel}
        className="react-popover-item react-top-menu__menu-item"
        disabled={resolvedCommand.enabled === false}
        key={resolvedCommand.id}
        role="menuitem"
        title={resolvedCommand.externalUrl
          ? t("menu.openExternal", { label: resolvedCommand.label })
          : accessibleLabel}
        type="button"
        onClick={(event) => runTopMenuCommand(
          resolvedCommand,
          event.detail === 0 ? "keyboard" : "pointer",
        )}
      >
        <span className="react-top-menu__menu-label">{resolvedCommand.label}</span>
        {resolvedCommand.externalUrl || resolvedCommand.route === route || resolvedCommand.shortcut ? (
          <span className="react-top-menu__menu-meta">
            {resolvedCommand.externalUrl ? (
              <ExternalLink aria-hidden="true" className="react-top-menu__external-link" size={14} />
            ) : null}
            {resolvedCommand.route === route ? (
              <Check aria-hidden="true" className="react-top-menu__current" size={15} />
            ) : null}
            {resolvedCommand.shortcut ? <span className="react-top-menu__shortcut">{resolvedCommand.shortcut}</span> : null}
          </span>
        ) : null}
      </button>
    );
  }

  function renderTopMenuEntry(entry: TopMenuEntry) {
    if (entry.kind === "separator") {
      return <div className="react-top-menu__separator" key={entry.id} role="separator" />;
    }
    return renderTopMenuCommand(entry.command);
  }

  return (
    <div
      className="react-desktop-shell"
      data-menu-motion={menuMotionSource}
      data-sidebar-motion={sidebarMotionSource}
    >
      <header
        aria-label={t("shell.frame")}
        className="react-window-frame"
        data-tauri-drag-region=""
        role="banner"
        onDoubleClick={handleFrameDoubleClick}
      >
        <nav aria-label={t("shell.pageHistory")} className="react-window-frame__history" data-no-window-drag="">
          <button
            aria-label={t("shell.goBack")}
            disabled={routeHistory.back.length === 0}
            title={t("shell.back")}
            type="button"
            onClick={goBack}
          >
            <ArrowLeft aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={t("shell.goForward")}
            disabled={routeHistory.forward.length === 0}
            title={t("shell.forward")}
            type="button"
            onClick={goForward}
          >
            <ArrowRight aria-hidden="true" size={17} />
          </button>
        </nav>
        <nav className="react-top-menu" aria-label={t("menu.applicationLabel")}>
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
                  className="react-popover-surface react-top-menu__popover"
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
          aria-label={t("shell.windowControls")}
          className="react-window-frame__controls"
          data-no-window-drag=""
          role="group"
          onDoubleClick={stopWindowFrameEvent}
          onPointerDown={stopWindowFrameEvent}
        >
          <button
            aria-label={t("shell.minimizeWindow")}
            className="react-window-frame__control"
            title={t("shell.minimize")}
            type="button"
            onClick={() => runWindowFrameAction("minimize")}
          >
            <Minus aria-hidden="true" size={14} />
          </button>
          <button
            aria-label={t("shell.maximizeWindow")}
            className="react-window-frame__control"
            title={t("shell.maximize")}
            type="button"
            onClick={() => runWindowFrameAction("toggleMaximize")}
          >
            <Square aria-hidden="true" size={12} />
          </button>
          <button
            aria-label={t("shell.closeWindow")}
            className="react-window-frame__control react-window-frame__control--close"
            title={t("shell.close")}
            type="button"
            onClick={() => runWindowFrameAction("close")}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      </header>

      <div className="react-workbench-layout">
        <section className="react-route-surface">
          <RouteSurface
            chat={{
              activateSessionRequest: activateChatSessionRequest,
              createSessionSignal: createChatSignal,
              now,
              sessionSidebarCollapsed,
              onActiveWorkspaceChange: setActiveWorkspaceDirectory,
              onSessionSidebarCollapsedChange: (collapsed) => {
                setSidebarMotionSource("pointer");
                setSessionSidebarCollapsed(collapsed);
              },
              onMascotMoodChange: setDesktopPetMood,
              onStopGenerationTargetChange: handleStopGenerationTargetChange,
              onStartupSessionHydrated: handleStartupSessionHydrated,
              startInNewSession: startChatInNewSession,
            }}
            desktopPet={{
              onPreferencesChange: updateDesktopPetPreferences,
              onResetPosition: resetDesktopPetPosition,
              preferences: desktopPetPreferences,
            }}
            route={route}
            settingsNavigationRequest={settingsNavigationRequest}
            services={services}
            workingDirectory={activeWorkspaceDirectory}
            onNavigate={navigateToRoute}
          />
        </section>
      </div>

      {!desktopPetHost && desktopPetPreferences.visible ? (
        <DesktopPet
          label={desktopPetLabel}
          mood={desktopPetMood}
          onPreferencesChange={updateDesktopPetPreferences}
          preferences={desktopPetPreferences}
          resetPositionSignal={desktopPetResetPositionSignal}
        />
      ) : null}

      <DesktopUpdateDialogs
        aboutOpenSignal={aboutOpenSignal}
        updateClient={updateClient}
        whatsNewOpenSignal={whatsNewOpenSignal}
      />

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

function sameDesktopPetPreferences(
  left: DesktopPetPreferences,
  right: DesktopPetPreferences,
): boolean {
  return left.visible === right.visible
    && left.appearance === right.appearance
    && left.size === right.size
    && sameDesktopPetPosition(left.position, right.position);
}

function sameDesktopPetPosition(
  left: DesktopPetPosition | null,
  right: DesktopPetPosition | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.x === right.x
    && left.y === right.y
  );
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

function openExternalMenuUrl(url: string): void {
  void openUrl(url).catch((error) => {
    console.error("[tinybot-shell] Failed to open external menu link.", { error, url });
  });
}

function menuCommandAccessibleLabel(command: TopMenuCommand): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}
