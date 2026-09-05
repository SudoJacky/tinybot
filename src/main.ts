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
entryTrace.mark("entry.ready");
entryTrace.start("workbench.import");

// Keep bootstrap failures visible even when the workbench chunk cannot load.
void import("./react-workbench/main").then(() => {
  entryTrace.complete("workbench.import");
}).catch((error: unknown) => {
  entryTrace.fail("workbench.import", error);
  console.error("[tinybot-startup-error]", error);
  removeStartupSplash();
  const diagnostic = buildRendererDiagnostic("window.unhandledrejection", error);
  showRendererDiagnosticOverlay(diagnostic);
  void recordRendererDiagnostic(diagnostic);
});
