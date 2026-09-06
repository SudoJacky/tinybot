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
const entry = surface === "desktop-pet" ? import("./react-workbench/petMain")
  : surface === "desktop-pet-chat" ? import("./react-workbench/quickChatMain")
    : import("./react-workbench/main");
void entry.then(() => {
  entryTrace.complete("workbench.import");
}).catch((error: unknown) => {
  entryTrace.fail("workbench.import", error);
  console.error("[tinybot-startup-error]", error);
  removeStartupSplash();
  const diagnostic = buildRendererDiagnostic("window.unhandledrejection", error);
  showRendererDiagnosticOverlay(diagnostic);
  void recordRendererDiagnostic(diagnostic);
});
