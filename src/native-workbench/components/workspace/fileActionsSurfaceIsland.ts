import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";
import { mountFileImportCardIsland } from "./fileImportCardIsland";
import { mountFileOperationStatusIsland } from "./fileOperationStatusIsland";
import { mountFileUploadStatusIsland } from "./fileUploadStatusIsland";
import { mountSessionFileListIsland } from "../chat/sessionFileListIsland";
import { mountSessionUploadCardIsland } from "../chat/sessionUploadCardIsland";

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
    id: "desktop-session-file-upload",
    label: "Attach to session",
    uploadKind: "session-temporary-file",
    dropTarget: "session-temporary-file",
    formatsId: "desktop-file-session-formats",
    formats: ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg"],
  },
];

export function mountFileActionsSurfaceIsland(
  host: HTMLElement,
  options: FileActionsSurfaceIslandOptions,
): MountedFileActionsSurfaceIsland {
  host.className = "desktop-file-actions";
  host.setAttribute("data-desktop-vue-island", "file-actions-surface");
  host.setAttribute("data-desktop-module-surface", "chat attachments");
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
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const sessionImport = ref<HTMLElement | null>(null);
      const sessionUpload = ref<HTMLElement | null>(null);
      const sessionStatus = ref<HTMLElement | null>(null);
      const uploadStatus = ref<HTMLElement | null>(null);
      const sessionFiles = ref<HTMLElement | null>(null);
      const activeSessionKey = options.activeSessionKey ?? "";

      onMounted(() => {
        mountChild(mountedChildren, sessionImport.value, (host) => mountFileImportCardIsland(host, fileImportCards[0]));
        mountChild(mountedChildren, sessionUpload.value, (host) => mountSessionUploadCardIsland(host, { activeSessionKey }));
        mountChild(mountedChildren, sessionStatus.value, (host) => mountFileOperationStatusIsland(host, { label: "Session upload", status: "Waiting" }));
        mountChild(mountedChildren, uploadStatus.value, (host) => mountFileUploadStatusIsland(host, { message: "No file operation running." }));
        mountChild(mountedChildren, sessionFiles.value, (host) => mountSessionFileListIsland(host, {
          rows: [],
          sessionKey: activeSessionKey,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-file-actions-card",
          size: "small",
          bordered: false,
        }, {
          default: () => [
            h("h2", "Session attachments"),
            h("div", { class: "desktop-file-import-grid" }, [
              h("div", { ref: sessionImport }),
              h("div", { ref: sessionUpload }),
            ]),
            h("div", { class: "desktop-file-operation-strip" }, [
              h("div", { ref: sessionStatus }),
              h("p", { ref: uploadStatus }),
            ]),
            h("div", { ref: sessionFiles }),
          ],
        }),
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
