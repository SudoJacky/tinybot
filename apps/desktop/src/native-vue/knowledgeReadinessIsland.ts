import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NProgress, NSpace, NTag } from "naive-ui";
import type { DesktopKnowledgeReadinessRow, DesktopKnowledgeReadinessView } from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface KnowledgeReadinessIslandOptions {
  readiness: DesktopKnowledgeReadinessView;
  configHints: string[];
}

export interface MountedKnowledgeReadinessIsland {
  unmount: () => void;
}

export function mountKnowledgeReadinessIsland(
  host: HTMLElement,
  options: KnowledgeReadinessIslandOptions,
): MountedKnowledgeReadinessIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-readiness");
  host.className = "desktop-knowledge-readiness";
  const app = createKnowledgeReadinessApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeReadinessApp(options: KnowledgeReadinessIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeReadinessIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", "Readiness"),
            h(NProgress, {
              percentage: options.readiness.score,
              processing: options.readiness.partialAvailability,
              status: progressStatus(options.readiness),
              type: "line",
            }),
            h("p", `Score: ${options.readiness.score}%`),
            renderHints(options.configHints),
            renderRows(options.readiness.rows),
          ],
        }),
      });
    },
  }));
}

function renderHints(configHints: string[]) {
  return h(NSpace, { vertical: true, size: 4 }, {
    default: () => configHints.map((hint) => h("p", hint)),
  });
}

function renderRows(rows: DesktopKnowledgeReadinessRow[]) {
  return h(NSpace, { vertical: true, size: 4 }, {
    default: () => rows.map((row) => h("p", [
      `${row.id}: ${row.tone}`,
      " ",
      h(NTag, { size: "small", round: true, type: rowToneType(row.tone) }, { default: () => row.tone }),
    ])),
  });
}

function progressStatus(readiness: DesktopKnowledgeReadinessView): "success" | "warning" | "error" {
  if (readiness.failedStageCount > 0) {
    return "error";
  }
  if (readiness.partialAvailability || readiness.staleStageCount > 0) {
    return "warning";
  }
  return "success";
}

function rowToneType(tone: DesktopKnowledgeReadinessRow["tone"]): "default" | "error" | "success" | "warning" {
  if (tone === "ready") {
    return "success";
  }
  if (tone === "warn") {
    return "warning";
  }
  if (tone === "error") {
    return "error";
  }
  return "default";
}
