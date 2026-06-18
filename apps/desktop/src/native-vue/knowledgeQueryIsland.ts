import { createApp, defineComponent, h, ref, type App } from "vue";
import { NCard, NConfigProvider, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import type {
  DesktopKnowledgePaneModel,
  DesktopKnowledgeQueryResultRow,
  DesktopKnowledgeQueryResultView,
} from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

const KNOWLEDGE_QUERY_RESULT_LIMIT = 4;

export interface KnowledgeQueryIslandOptions {
  draft: DesktopKnowledgePaneModel["query"]["draft"];
  results: DesktopKnowledgeQueryResultView;
  onRunQuery?: (draft: DesktopKnowledgePaneModel["query"]["draft"]) => void;
}

export interface MountedKnowledgeQueryIsland {
  unmount: () => void;
}

export function mountKnowledgeQueryIsland(
  host: HTMLElement,
  options: KnowledgeQueryIslandOptions,
): MountedKnowledgeQueryIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-query");
  host.className = "desktop-knowledge-query";
  const app = createKnowledgeQueryApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeQueryApp(options: KnowledgeQueryIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeQueryIsland",
    setup() {
      const query = ref(options.draft.query);
      const mode = ref(options.draft.mode);
      const topK = ref(options.draft.topK);
      const runQuery = () => {
        options.onRunQuery?.({
          query: query.value.trim(),
          mode: mode.value,
          topK: Number.isFinite(topK.value) && topK.value > 0 ? Math.trunc(topK.value) : 5,
        });
      };
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", "Knowledge Query"),
            h("div", { class: "desktop-knowledge-query-controls" }, [
              h("input", {
                "aria-label": "Knowledge query",
                "data-desktop-knowledge-query-input": "",
                placeholder: "Ask your knowledge base...",
                type: "search",
                value: query.value,
                onInput: (event: Event) => {
                  query.value = (event.target as HTMLInputElement).value;
                },
              }),
              h("select", {
                "aria-label": "Knowledge query mode",
                "data-desktop-knowledge-query-mode": "",
                value: mode.value,
                onChange: (event: Event) => {
                  mode.value = (event.target as HTMLSelectElement).value;
                },
              }, [
                h("option", { value: "hybrid" }, "Hybrid"),
                h("option", { value: "local" }, "Local"),
                h("option", { value: "global" }, "Global"),
              ]),
              h("input", {
                "aria-label": "Knowledge query top K",
                "data-desktop-knowledge-query-top-k": "",
                min: "1",
                step: "1",
                type: "number",
                value: String(topK.value),
                onInput: (event: Event) => {
                  topK.value = Number((event.target as HTMLInputElement).value);
                },
              }),
              h("button", {
                "data-desktop-knowledge-action": "runQuery",
                disabled: !query.value.trim(),
                type: "button",
                onClick: runQuery,
              }, "Run Query"),
            ]),
            h("p", `Mode: ${options.draft.mode} / top ${options.draft.topK}`),
            h("p", `Results: ${options.results.summary.count}`),
            renderRetrievalPlan(options.results.summary.retrievalPlan),
            options.results.rows.length
              ? renderResults(options.results.rows)
              : h(NEmpty, {
                class: "desktop-knowledge-query-empty",
                description: "No knowledge query results.",
                size: "small",
              }),
          ],
        }),
      });
    },
  }));
}

function renderRetrievalPlan(plan: DesktopKnowledgeQueryResultView["summary"]["retrievalPlan"]) {
  if (!plan) {
    return null;
  }
  return h(NSpace, {
    class: "desktop-knowledge-query-plan",
    size: 4,
    wrap: true,
  }, {
    default: () => [
      h(NTag, { size: "small", round: true, type: "info" }, { default: () => `Plan: ${plan.classification}` }),
      plan.routes.length ? h(NTag, { size: "small", round: true }, { default: () => `Routes: ${plan.routes.join(" + ")}` }) : null,
      plan.budgetLabel ? h(NTag, { size: "small", round: true }, { default: () => plan.budgetLabel }) : null,
      plan.treeLabel ? h(NTag, { size: "small", round: true }, { default: () => plan.treeLabel }) : null,
      plan.graphLabel ? h(NTag, { size: "small", round: true }, { default: () => plan.graphLabel }) : null,
    ],
  });
}

function renderResults(rows: DesktopKnowledgeQueryResultRow[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_QUERY_RESULT_LIMIT).map((row) => h(NListItem, {
      "data-desktop-knowledge-query-result": row.id,
    }, {
      default: () => h(NSpace, { vertical: true, size: 4 }, {
        default: () => [
          h("span", `${row.docName}: ${row.content}`),
          h(NSpace, { size: 4, wrap: true }, {
            default: () => [
              h(NTag, { size: "small", round: true, type: relevanceType(row.relevance) }, { default: () => row.relevance }),
              row.scoreLabel ? h(NTag, { size: "small", round: true }, { default: () => row.scoreLabel }) : null,
            ],
          }),
        ],
      }),
    })),
  });
}

function relevanceType(relevance: DesktopKnowledgeQueryResultRow["relevance"]): "default" | "success" | "warning" {
  if (relevance === "high") {
    return "success";
  }
  if (relevance === "low") {
    return "warning";
  }
  return "default";
}
