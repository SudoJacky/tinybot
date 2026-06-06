import { createApp, defineComponent, h, type App } from "vue";
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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", `Query: ${options.draft.query || "empty"}`),
            h("p", `Mode: ${options.draft.mode} / top ${options.draft.topK}`),
            h("p", `Results: ${options.results.summary.count}`),
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
