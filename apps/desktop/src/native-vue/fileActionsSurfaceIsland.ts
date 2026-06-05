import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface FileActionsSurfaceIslandOptions {
  activeSessionKey?: string | null;
}

export interface MountedFileActionsSurfaceIsland {
  unmount: () => void;
}

interface FileImportCard {
  id: string;
  label: string;
  uploadKind?: string;
  dropTarget: string;
  formatsId: string;
  formats: string[];
  href?: string;
}

const fileImportCards: FileImportCard[] = [
  {
    id: "desktop-knowledge-upload",
    label: "Import knowledge",
    uploadKind: "knowledge-document",
    dropTarget: "knowledge-document",
    formatsId: "desktop-file-knowledge-formats",
    formats: ["md", "pdf", "docx", "csv", "json"],
  },
  {
    id: "desktop-session-file-upload",
    label: "Attach to session",
    uploadKind: "session-temporary-file",
    dropTarget: "session-temporary-file",
    formatsId: "desktop-file-session-formats",
    formats: ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg"],
  },
  {
    id: "desktop-workspace-file-drop",
    label: "Workspace import",
    href: "/workspace",
    dropTarget: "workspace-file",
    formatsId: "desktop-file-workspace-formats",
    formats: ["md", "txt", "json", "csv", "py", "js", "ts", "html", "css", "yaml", "toml"],
  },
];

export function mountFileActionsSurfaceIsland(
  host: HTMLElement,
  options: FileActionsSurfaceIslandOptions,
): MountedFileActionsSurfaceIsland {
  host.className = "desktop-file-actions";
  host.setAttribute("data-desktop-vue-island", "file-actions-surface");
  host.setAttribute("data-desktop-module-surface", "workspace knowledge");
  const app = createFileActionsSurfaceApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createFileActionsSurfaceApp(options: FileActionsSurfaceIslandOptions): App {
  return createApp(defineComponent({
    name: "FileActionsSurfaceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "File imports"),
          renderImportGrid(options.activeSessionKey ?? ""),
          renderOperationStrip(),
          renderSessionFileList(options.activeSessionKey ?? ""),
        ],
      });
    },
  }));
}

function renderImportGrid(activeSessionKey: string) {
  return h("div", { class: "desktop-file-import-grid" }, [
    renderFileImportCard(fileImportCards[0]),
    renderFileImportCard(fileImportCards[1]),
    renderSessionUploadCard(activeSessionKey),
    renderFileImportCard(fileImportCards[2]),
  ]);
}

function renderFileImportCard(card: FileImportCard) {
  return h("div", { class: "desktop-file-import-card" }, [
    renderFileImportControl(card),
    renderFormats(card.formatsId, card.formats),
  ]);
}

function renderFileImportControl(card: FileImportCard) {
  const attrs = {
    id: card.id,
    class: "desktop-file-action desktop-file-import-button",
    "data-desktop-drop-target": card.dropTarget,
    "data-desktop-file-upload": card.uploadKind,
  };
  const children = [
    h("span", card.label),
    h("small", "Drop files here or click to select"),
  ];
  if (card.href) {
    return h("a", { ...attrs, href: card.href }, children);
  }
  return h("button", { ...attrs, type: "button" }, children);
}

function renderFormats(id: string, formats: string[]) {
  return h("p", { id, class: "desktop-file-format-row" }, [
    h("span", "Formats:"),
    ...formats.map((format) => h(NTag, {
      class: "desktop-file-format-chip",
      size: "small",
      round: true,
    }, { default: () => format })),
  ]);
}

function renderSessionUploadCard(activeSessionKey: string) {
  return h("div", { class: "desktop-file-session-card" }, [
    h("label", { for: "desktop-session-upload-key" }, "Session key"),
    h("input", {
      id: "desktop-session-upload-key",
      class: "desktop-session-upload-key",
      "aria-label": "Session key for temporary file upload",
      placeholder: "Session key",
      value: activeSessionKey,
      readonly: activeSessionKey ? "" : undefined,
      "data-active-session-key": activeSessionKey || undefined,
    }),
    h("div", { class: "desktop-file-session-meta" }, [
      h("span", "Temporary files"),
      h(NTag, {
        id: "desktop-session-file-count",
        class: "desktop-file-count-pill",
        size: "small",
        round: true,
      }, { default: () => "0" }),
      h(NButton, {
        id: "desktop-session-files-refresh",
        class: "desktop-file-refresh",
        type: "default",
        size: "small",
        "data-desktop-session-files-refresh": "true",
      }, { default: () => "Refresh" }),
    ]),
  ]);
}

function renderOperationStrip() {
  return h("div", { class: "desktop-file-operation-strip" }, [
    renderOperationStatus("Knowledge upload", "Waiting"),
    renderOperationStatus("Session upload", "Waiting"),
    renderOperationStatus("Workspace import", "Waiting"),
    h("p", {
      id: "desktop-file-upload-status",
      class: "desktop-file-upload-status",
    }, "No file operation running."),
  ]);
}

function renderOperationStatus(label: string, status: string) {
  return h("div", { class: "desktop-file-operation-status" }, [
    h("span", label),
    h("strong", status),
  ]);
}

function renderSessionFileList(activeSessionKey: string) {
  return h("div", {
    id: "desktop-session-file-list",
    class: "desktop-session-file-list",
    "aria-label": "Session temporary files",
  }, activeSessionKey ? "Temporary files not loaded yet." : "Select a chat session to view temporary files.");
}
