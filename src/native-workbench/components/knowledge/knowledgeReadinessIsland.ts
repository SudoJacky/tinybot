import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NProgress, NSpace, NTag } from "naive-ui";
import type { DesktopKnowledgeReadinessRow, DesktopKnowledgeReadinessView } from "../../knowledge/desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

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
        default: () => h("div", { class: "desktop-knowledge-pipeline-workspace" }, [
          h("div", { class: "desktop-knowledge-pipeline-steps" }, pipelineSteps(options.readiness).map((step) => h("article", {
            class: `desktop-knowledge-pipeline-step desktop-knowledge-pipeline-step-${step.state}`,
          }, [
            h("span", { class: "desktop-knowledge-pipeline-dot" }),
            h("strong", step.label),
            h("span", step.detail),
          ]))),
          h(NProgress, {
            percentage: options.readiness.score,
            processing: options.readiness.partialAvailability,
            status: progressStatus(options.readiness),
            type: "line",
          }),
          h("p", `${completedStepCount(options.readiness)} / 6 steps`),
          renderHints(options.configHints),
          renderRows(options.readiness.rows),
        ]),
      });
    },
  }));
}

function pipelineSteps(readiness: DesktopKnowledgeReadinessView) {
  const rows = new Map(readiness.rows.map((row) => [row.id, row]));
  const retrieval = rows.get("retrieval");
  const graph = rows.get("graph");
  const retrievalReady = retrieval?.tone === "ready";
  const graphReady = graph?.tone === "ready";
  return [
    { label: "Upload", detail: readiness.score > 0 ? "Sources loaded" : "No files", state: readiness.score > 0 ? "done" : "wait" },
    { label: "Parse", detail: retrievalReady ? "Ready" : "Wait", state: retrievalReady ? "done" : "active" },
    { label: "Chunk", detail: retrievalReady ? "Chunks indexed" : retrieval?.detail || "Wait", state: retrievalReady ? "done" : "wait" },
    { label: "Embed", detail: retrievalReady ? "Ready" : "In progress", state: retrievalReady ? "done" : "active" },
    { label: "Graph Build", detail: graphReady ? graph?.detail || "Ready" : graph?.detail || "Wait", state: graphReady ? "done" : "wait" },
    { label: "Complete", detail: readiness.score >= 100 ? "Complete" : "-", state: readiness.score >= 100 ? "done" : "wait" },
  ];
}

function completedStepCount(readiness: DesktopKnowledgeReadinessView): number {
  return pipelineSteps(readiness).filter((step) => step.state === "done").length;
}

function renderHints(configHints: string[]) {
  return h(NSpace, { vertical: true, size: 4 }, {
    default: () => configHints.map((hint) => h("p", hint)),
  });
}

function renderRows(rows: DesktopKnowledgeReadinessRow[]) {
  return h(NSpace, { vertical: true, size: 4 }, {
    default: () => rows.map((row) => h("p", { class: "desktop-knowledge-stage-detail" }, [
      `${row.id}: ${row.status}`,
      " ",
      h(NTag, { size: "small", round: true, type: rowToneType(row.tone) }, { default: () => row.tone }),
      row.detail ? h("span", ` ${row.detail}`) : null,
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
