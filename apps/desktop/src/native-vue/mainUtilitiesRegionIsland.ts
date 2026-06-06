import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import type { DesktopKnowledgePaneModel } from "../desktopKnowledgeTraceability";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import type { DesktopToolsSkillsPaneModel } from "../desktopToolsSkills";
import type { DesktopCoworkObservabilityPanel } from "../desktopCowork";
import type {
  DesktopCoworkActionEvent,
  DesktopCoworkPaneModel,
  DesktopSettingsActionEvent,
} from "../desktopWorkbenchShell";
import { mountAgentUiFormsSurfaceIsland } from "./agentUiFormsSurfaceIsland";
import { mountCommandPaletteIsland } from "./commandPaletteIsland";
import {
  mountCoworkPaneIsland,
  type CoworkPaneGraphSelection,
} from "./coworkPaneIsland";
import { mountFileActionsSurfaceIsland } from "./fileActionsSurfaceIsland";
import {
  mountHelpSurfaceIsland,
  type HelpSurfaceAction,
} from "./helpSurfaceIsland";
import {
  mountKnowledgePaneIsland,
  type KnowledgePaneActionEvent,
} from "./knowledgePaneIsland";
import { mountSettingsPaneIsland } from "./settingsPaneIsland";
import {
  mountToolsSkillsPaneIsland,
  type ToolsSkillsPaneActionEvent,
} from "./toolsSkillsPaneIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountWorkspaceFilesSurfaceIsland } from "./workspaceFilesSurfaceIsland";

export interface MainUtilitiesRegionIslandOptions {
  activeSessionKey?: string | null;
  agentUiForms: AgentUiForm[];
  coworkPane?: DesktopCoworkPaneModel | null;
  knowledgePane?: DesktopKnowledgePaneModel | null;
  knowledgeWorkItems?: DesktopTaskCenterItem[];
  onAgentUiCancel?: (form: AgentUiForm) => void;
  onAgentUiSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onCoworkAction?: (event: DesktopCoworkActionEvent) => void;
  onCoworkGraphSelect?: (selection: CoworkPaneGraphSelection) => void;
  onCoworkObservabilityPanelSelected?: (panel: DesktopCoworkObservabilityPanel) => void;
  onCoworkSessionSelect?: (session: DesktopCoworkPaneModel["sessionRows"][number]) => void;
  onFocusSettingsControl?: (fieldId: string) => void;
  onHelpAction?: (action: HelpSurfaceAction) => void;
  onInspectKnowledgeWorkItem?: (item: DesktopTaskCenterItem) => void;
  onKnowledgeAction?: (event: KnowledgePaneActionEvent) => void;
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
  onToolsSkillsAction?: (event: ToolsSkillsPaneActionEvent) => void;
  promptProviderId?: () => string | null;
  settingsPane?: DesktopSettingsPaneModel | null;
  toolsSkillsPane?: DesktopToolsSkillsPaneModel | null;
}

export interface MountedMainUtilitiesRegionIsland {
  unmount: () => void;
}

interface MountedChildIsland {
  unmount: () => void;
}

export function mountMainUtilitiesRegionIsland(
  host: HTMLElement,
  options: MainUtilitiesRegionIslandOptions,
): MountedMainUtilitiesRegionIsland {
  host.className = "desktop-utility-surfaces";
  host.setAttribute("data-desktop-vue-island", "main-utilities-region");
  const app = createMainUtilitiesRegionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createMainUtilitiesRegionApp(options: MainUtilitiesRegionIslandOptions): App {
  return createApp(defineComponent({
    name: "MainUtilitiesRegionIsland",
    setup() {
      const mountedChildren: MountedChildIsland[] = [];
      const commandPalette = ref<HTMLElement | null>(null);
      const fileActions = ref<HTMLElement | null>(null);
      const helpSurface = ref<HTMLElement | null>(null);
      const agentUiForms = ref<HTMLElement | null>(null);
      const workspaceFiles = ref<HTMLElement | null>(null);
      const settingsPane = ref<HTMLElement | null>(null);
      const knowledgePane = ref<HTMLElement | null>(null);
      const toolsSkillsPane = ref<HTMLElement | null>(null);
      const coworkPane = ref<HTMLElement | null>(null);

      onMounted(() => {
        mountChild(mountedChildren, commandPalette.value, (host) => mountCommandPaletteIsland(host));
        mountChild(mountedChildren, fileActions.value, (host) => mountFileActionsSurfaceIsland(host, {
          activeSessionKey: options.activeSessionKey ?? null,
        }));
        mountChild(mountedChildren, helpSurface.value, (host) => mountHelpSurfaceIsland(host, {
          onAction: options.onHelpAction,
        }));
        mountChild(mountedChildren, agentUiForms.value, (host) => mountAgentUiFormsSurfaceIsland(host, {
          forms: options.agentUiForms,
          onCancel: options.onAgentUiCancel,
          onSubmit: options.onAgentUiSubmit,
        }));
        mountChild(mountedChildren, workspaceFiles.value, (host) => mountWorkspaceFilesSurfaceIsland(host));
        const nextSettingsPane = options.settingsPane;
        if (nextSettingsPane) {
          mountChild(mountedChildren, settingsPane.value, (host) => mountSettingsPaneIsland(host, {
            pane: nextSettingsPane,
            onFocusSettingsControl: options.onFocusSettingsControl,
            onSettingsAction: options.onSettingsAction,
            promptProviderId: options.promptProviderId,
          }));
        }
        const nextKnowledgePane = options.knowledgePane;
        if (nextKnowledgePane) {
          mountChild(mountedChildren, knowledgePane.value, (host) => mountKnowledgePaneIsland(host, {
            pane: nextKnowledgePane,
            workItems: options.knowledgeWorkItems ?? [],
            onInspectWorkItem: options.onInspectKnowledgeWorkItem,
            onKnowledgeAction: options.onKnowledgeAction,
          }));
        }
        const nextToolsSkillsPane = options.toolsSkillsPane;
        if (nextToolsSkillsPane) {
          mountChild(mountedChildren, toolsSkillsPane.value, (host) => mountToolsSkillsPaneIsland(host, {
            pane: nextToolsSkillsPane,
            onToolsSkillsAction: options.onToolsSkillsAction,
          }));
        }
        const nextCoworkPane = options.coworkPane;
        if (nextCoworkPane) {
          mountChild(mountedChildren, coworkPane.value, (host) => mountCoworkPaneIsland(host, {
            pane: nextCoworkPane,
            onCoworkAction: options.onCoworkAction,
            onGraphSelect: options.onCoworkGraphSelect,
            onObservabilityPanelSelected: options.onCoworkObservabilityPanelSelected,
            onSessionSelect: options.onCoworkSessionSelect,
          }));
        }
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          class: "desktop-main-utilities-region",
          vertical: true,
          size: 12,
        }, {
          default: () => [
            h("section", { ref: commandPalette }),
            h("section", { ref: fileActions }),
            h("section", { ref: helpSurface }),
            h("section", { ref: agentUiForms }),
            h("section", { ref: workspaceFiles }),
            options.settingsPane ? h("section", { ref: settingsPane }) : null,
            options.knowledgePane ? h("section", { ref: knowledgePane }) : null,
            options.toolsSkillsPane ? h("section", { ref: toolsSkillsPane }) : null,
            options.coworkPane ? h("section", { ref: coworkPane }) : null,
          ],
        }),
      });
    },
  }));
}

function mountChild(
  mountedChildren: MountedChildIsland[],
  host: HTMLElement | null,
  mount: (host: HTMLElement) => MountedChildIsland,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
