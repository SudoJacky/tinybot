import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { DesktopSessionTemporaryFileRow } from "../desktopFileUpload";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SessionFileListIslandOptions {
  sessionKey: string;
  rows: DesktopSessionTemporaryFileRow[];
}

export interface MountedSessionFileListIsland {
  update: (options: SessionFileListIslandOptions) => void;
  unmount: () => void;
}

const mountedSessionFileLists = new WeakMap<HTMLElement, MountedSessionFileListIsland>();

export function mountOrUpdateSessionFileListIsland(
  host: HTMLElement,
  options: SessionFileListIslandOptions,
): MountedSessionFileListIsland {
  const mounted = mountedSessionFileLists.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  const nextMounted = mountSessionFileListIsland(host, options);
  mountedSessionFileLists.set(host, nextMounted);
  return nextMounted;
}

export function mountSessionFileListIsland(
  host: HTMLElement,
  options: SessionFileListIslandOptions,
): MountedSessionFileListIsland {
  applyHostContract(host, options);
  const state = ref(options);
  const app = createSessionFileListApp(state);
  app.mount(host);
  return {
    update: (nextOptions) => {
      applyHostContract(host, nextOptions);
      state.value = nextOptions;
    },
    unmount: () => {
      mountedSessionFileLists.delete(host);
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSessionFileListApp(state: { value: SessionFileListIslandOptions }): App {
  return createApp(defineComponent({
    name: "SessionFileListIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderSessionFiles(state.value),
      });
    },
  }));
}

function renderSessionFiles(options: SessionFileListIslandOptions) {
  if (!options.sessionKey) {
    return h(NText, { depth: 3 }, { default: () => "Select a chat session to view temporary files." });
  }
  if (!options.rows.length) {
    return h(NText, { depth: 3 }, { default: () => "No temporary files attached to this session." });
  }
  return h("ul", { class: "desktop-session-temporary-file-list" }, options.rows.map((row) => h("li", {
    class: "desktop-session-temporary-file-row",
    "data-session-temporary-file-id": row.id,
  }, sessionFileRowText(row))));
}

function applyHostContract(host: HTMLElement, options: SessionFileListIslandOptions): void {
  host.setAttribute("data-desktop-vue-island", "session-file-list");
  host.setAttribute("id", "desktop-session-file-list");
  host.setAttribute("class", "desktop-session-file-list");
  host.setAttribute("aria-label", "Session temporary files");
  host.dataset.sessionKey = options.sessionKey;
  host.dataset.fileCount = String(options.rows.length);
}

function sessionFileRowText(row: DesktopSessionTemporaryFileRow): string {
  const details = [
    row.status,
    row.mimeType,
    typeof row.sizeBytes === "number" ? formatFileSize(row.sizeBytes) : "",
    row.updatedAt,
  ].filter(Boolean);
  const actions = row.actions.length ? row.actions.join(", ") : "No cleanup action exposed";
  return `${row.name} - ${details.join(" / ")} - ${actions}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
}
