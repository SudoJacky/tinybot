import { useEffect, useMemo } from "react";
import { installRendererDiagnosticHandlers } from "../app-core/native/rendererDiagnostics";
import { createDesktopAppServices } from "./defaultServices";
import type { DesktopNativeStartupTrace } from "../app-core/native/desktopNativeChatDebug";
import { DesktopShell } from "./shell/DesktopShell";
import { dismissStartupSplash } from "./startupSplash";
import { TinybotErrorBoundary } from "./TinybotErrorBoundary";

export function App({ startupTrace }: { startupTrace?: DesktopNativeStartupTrace } = {}) {
  const services = useMemo(() => createDesktopAppServices({ startupTrace }), [startupTrace]);
  useEffect(() => installRendererDiagnosticHandlers(), []);
  useEffect(() => {
    startupTrace?.complete("react.commit");
    startupTrace?.start("react.firstFrame");
    const frame = window.requestAnimationFrame(() => {
      startupTrace?.complete("react.firstFrame");
      startupTrace?.mark("ui.interactive");
      void dismissStartupSplash().then(() => startupTrace?.mark("splash.dismissed"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [startupTrace]);
  return (
    <TinybotErrorBoundary>
      <DesktopShell services={services} />
    </TinybotErrorBoundary>
  );
}
