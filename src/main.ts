import {
  buildRendererDiagnostic,
  recordRendererDiagnostic,
  showRendererDiagnosticOverlay,
} from "./app-core/native/rendererDiagnostics";
import { removeStartupSplash } from "./react-workbench/startupSplash";
import { installRendererPerformanceTracking } from "./app-core/native/rendererPerformance";
import { createDesktopNativeStartupTrace } from "./app-core/native/desktopNativeChatDebug";

installRendererPerformanceTracking();
const entryTrace = createDesktopNativeStartupTrace({ startedAt: 0 });
const surface = new URLSearchParams(window.location.search).get("surface");
entryTrace.mark("entry.ready", { surface: surface ?? "main" });
entryTrace.start("workbench.import");

// Keep bootstrap failures visible even when the workbench chunk cannot load.
// Separate branches keep Vite's CSS preload dependencies attached to the
// matching import. A conditional expression can hoist the last branch's list.
function importSurface() {
  switch (surface) {
    case "desktop-pet":
      return import("./react-workbench/petMain");
    case "desktop-pet-chat":
      return import("./react-workbench/quickChatMain");
    default:
      return import("./react-workbench/main");
  }
}
void importSurface().then(() => {
  entryTrace.complete("workbench.import");
}).catch((error: unknown) => {
  entryTrace.fail("workbench.import", error);
  console.error("[tinybot-startup-error]", error);
  removeStartupSplash();
  const diagnostic = buildRendererDiagnostic("window.unhandledrejection", error);
  showRendererDiagnosticOverlay(diagnostic);
  void recordRendererDiagnostic(diagnostic);
});
