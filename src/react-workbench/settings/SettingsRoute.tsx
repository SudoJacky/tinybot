import type { TFunction } from "i18next";
import { useEffect, useState, type ReactNode } from "react";
import { AppWindow, Bot, Cable, ChevronRight, Cloud, Keyboard, Radio, ShieldCheck, SunMoon, UserRound, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./SettingsRoute.css";
import type { AppServices, SettingsStore } from "../services";
import { AgentDefaultsSettingsPage } from "./AgentDefaultsSettingsPage";
import { AppSettingsPage } from "./AppSettingsPage";
import { AppearanceSettingsPage } from "./AppearanceSettingsPage";
import { ConfigSettingsPage, type ConfigSettingsGroupId } from "./ConfigSettingsPage";
import { KeyboardShortcutsSettingsPage } from "./KeyboardShortcutsSettingsPage";
import { HooksSettingsPage } from "./HooksSettingsPage";
import { PersonalizationSettingsPage } from "./PersonalizationSettingsPage";
import { ProviderModelsSettingsPage } from "./ProviderModelsSettingsPage";

export default function SettingsRoute({ services }: { services: AppServices }) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [activeSettingsModuleId, setActiveSettingsModuleId] = useState<SettingsModuleId>("provider-models");
  const settingsModules = createSettingsModules(t);
  if (services.settingsStore.loadProviderSettings && services.settingsStore.saveProviderSettings) {
    const availableModules = settingsModules.filter((module) => {
      if (module.id === "agent-defaults") {
        return Boolean(services.settingsStore.loadAgentDefaultsSettings && services.settingsStore.saveAgentDefaultsSettings);
      }
      if (module.id === "personalization") {
        return Boolean(services.settingsStore.loadPersonalizationInstructions && services.settingsStore.savePersonalizationInstructions);
      }
      if (module.id === "hooks") {
        return Boolean(services.hooksStore);
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
      <WorkbenchPage settings title={tCommon("routes.settings")}>
        <SettingsLayout
          activeModuleId={activeModuleId}
          modules={availableModules}
          onSelectModule={setActiveSettingsModuleId}
        >
          {activeModuleId === "app" ? (
            <AppSettingsPage />
          ) : activeModuleId === "personalization" ? (
            <PersonalizationSettingsPage settingsStore={services.settingsStore} />
          ) : activeModuleId === "appearance" ? (
            <AppearanceSettingsPage />
          ) : activeModuleId === "keyboard-shortcuts" ? (
            <KeyboardShortcutsSettingsPage />
          ) : activeModuleId === "agent-defaults" ? (
            <AgentDefaultsSettingsPage
              onNavigateToProviderModels={() => setActiveSettingsModuleId("provider-models")}
              settingsStore={services.settingsStore}
            />
          ) : activeModuleId === "hooks" && services.hooksStore ? (
            <HooksSettingsPage hooksStore={services.hooksStore} />
          ) : activeModuleId === "tools-mcp" || activeModuleId === "channels" ? (
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
  return <SettingsFallback settingsStore={services.settingsStore} />;
}

type SettingsFallbackState =
  | { status: "loading" }
  | { status: "ready"; settings: Awaited<ReturnType<SettingsStore["load"]>> }
  | { status: "failed"; error: Error };

function SettingsFallback({ settingsStore }: { settingsStore: SettingsStore }) {
  const { t } = useTranslation("common");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SettingsFallbackState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void settingsStore.load()
      .then((settings) => {
        if (!cancelled) setState({ status: "ready", settings });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-settings-fallback]", { attempt: attempt + 1, error });
        setState({ status: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, settingsStore]);

  if (state.status === "loading") {
    return <p aria-live="polite" className="react-empty-state" role="status">{t("deferredSurface.loading", { name: t("routes.settings") })}</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="react-empty-state" role="alert">
        <p>{t("deferredSurface.loadFailed", { message: state.error.message, name: t("routes.settings") })}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t("deferredSurface.retry", { name: t("routes.settings") })}
        </button>
      </div>
    );
  }
  return (
    <WorkbenchPage settings title={t("routes.settings")}>
      <DataList
        empty={t("settingsFallbackEmpty")}
        items={state.settings}
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

type SettingsModuleId = "app" | "personalization" | "appearance" | "keyboard-shortcuts" | "provider-models" | "agent-defaults" | "hooks" | ConfigSettingsGroupId;

type SettingsModule = {
  id: SettingsModuleId;
  label: string;
  description: string;
  icon: LucideIcon;
  groupId?: ConfigSettingsGroupId;
};

function createSettingsModules(t: TFunction<"settings">): SettingsModule[] {
  return [
    { id: "app", label: t("modules.app.label"), description: t("modules.app.description"), icon: AppWindow },
    { id: "personalization", label: t("modules.personalization.label"), description: t("modules.personalization.description"), icon: UserRound },
    { id: "appearance", label: t("modules.appearance.label"), description: t("modules.appearance.description"), icon: SunMoon },
    { id: "keyboard-shortcuts", label: t("modules.shortcuts.label"), description: t("modules.shortcuts.description"), icon: Keyboard },
    { id: "provider-models", label: t("modules.providers.label"), description: t("modules.providers.description"), icon: Cloud },
    { id: "agent-defaults", label: t("modules.agent.label"), description: t("modules.agent.description"), icon: Bot },
    { id: "hooks", label: t("modules.hooks.label"), description: t("modules.hooks.description"), icon: ShieldCheck },
    { id: "tools-mcp", label: t("modules.tools.label"), description: t("modules.tools.description"), icon: Cable, groupId: "tools-mcp" },
    { id: "channels", label: t("modules.channels.label"), description: t("modules.channels.description"), icon: Radio, groupId: "channels" },
  ];
}

function SettingsLayout({
  activeModuleId,
  children,
  modules,
  onSelectModule,
}: {
  activeModuleId: SettingsModuleId;
  children: ReactNode;
  modules: SettingsModule[];
  onSelectModule: (moduleId: SettingsModuleId) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="react-settings-layout">
      <aside className="react-settings-sidebar">
        <div className="react-settings-sidebar__intro">
          <span>{t("sidebar.title")}</span>
          <small>{t("sidebar.description")}</small>
        </div>
        <nav aria-label={t("sidebar.label")}>
          {modules.map((module) => {
            const Icon = module.icon;
            return (
              <button
                key={module.id}
                aria-current={module.id === activeModuleId ? "page" : undefined}
                aria-label={module.label}
                onClick={() => onSelectModule(module.id)}
                title={module.description}
                type="button"
              >
                <Icon aria-hidden="true" size={17} />
                <span>{module.label}</span>
                <ChevronRight aria-hidden="true" className="react-settings-sidebar__chevron" size={15} />
              </button>
            );
          })}
        </nav>
      </aside>
      <div className="react-settings-detail">{children}</div>
    </div>
  );
}

function WorkbenchPage({ children, settings = false, title }: { children: ReactNode; settings?: boolean; title: string }) {
  return (
    <div className={settings ? "react-workbench-page react-workbench-page--settings" : "react-workbench-page"}>
      <header><h1>{title}</h1></header>
      {children}
    </div>
  );
}

function DataList<T>({ empty, items, renderItem }: { empty: string; items: T[]; renderItem: (item: T) => ReactNode }) {
  if (!items.length) return <p className="react-empty-state">{empty}</p>;
  return <div className="react-data-list">{items.map(renderItem)}</div>;
}
