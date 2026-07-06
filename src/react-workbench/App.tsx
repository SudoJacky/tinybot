import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from "react";
import {
  buildRendererDiagnostic,
  installRendererDiagnosticHandlers,
  recordRendererDiagnostic,
  showRendererDiagnosticOverlay,
  type RendererDiagnostic,
} from "../app-core/native/rendererDiagnostics";
import { createDesktopAppServices } from "./defaultServices";
import { DesktopShell } from "./shell/DesktopShell";

export function App() {
  const services = useMemo(() => createDesktopAppServices(), []);
  useEffect(() => installRendererDiagnosticHandlers(), []);
  return (
    <TinybotErrorBoundary>
      <DesktopShell services={services} />
    </TinybotErrorBoundary>
  );
}

type TinybotErrorBoundaryProps = {
  children: ReactNode;
  recordDiagnostic?: (diagnostic: RendererDiagnostic) => void | Promise<void>;
};

type TinybotErrorBoundaryState = {
  crashId: string | null;
  error: Error | null;
};

export class TinybotErrorBoundary extends Component<TinybotErrorBoundaryProps, TinybotErrorBoundaryState> {
  state: TinybotErrorBoundaryState = { crashId: null, error: null };

  static getDerivedStateFromError(error: Error): TinybotErrorBoundaryState {
    return { crashId: null, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[tinybot-renderer-error]", error, info.componentStack);
    const diagnostic = buildRendererDiagnostic("react.render", error, {
      componentStack: info.componentStack ?? undefined,
    });
    showRendererDiagnosticOverlay(diagnostic);
    this.setState({ crashId: diagnostic.id });
    void (this.props.recordDiagnostic ?? recordRendererDiagnostic)(diagnostic);
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    return (
      <main className="react-fatal-error" role="alert">
        <h1>Tinybot UI crashed</h1>
        <p>{this.state.error.message || "An unexpected renderer error occurred."}</p>
        {this.state.crashId ? <p>Crash ID: {this.state.crashId}</p> : null}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    );
  }
}
