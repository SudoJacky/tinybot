import {
  buildRendererDiagnostic,
  recordRendererDiagnostic,
  showRendererDiagnosticOverlay,
} from "./app-core/native/rendererDiagnostics";
import { removeStartupSplash } from "./react-workbench/startupSplash";

// Keep bootstrap failures visible even when the workbench chunk cannot load.
void import("./react-workbench/main").catch((error: unknown) => {
  console.error("[tinybot-startup-error]", error);
  removeStartupSplash();
  const diagnostic = buildRendererDiagnostic("window.unhandledrejection", error);
  showRendererDiagnosticOverlay(diagnostic);
  void recordRendererDiagnostic(diagnostic);
});
