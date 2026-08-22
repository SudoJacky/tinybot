import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { installRendererDiagnosticHandlers } from "../app-core/native/rendererDiagnostics";
import { App, TinybotErrorBoundary } from "./App";
import { AppAppearanceProvider } from "./settings/AppAppearanceContext";
import { AppLanguageProvider } from "./settings/AppLanguageContext";
import { DesktopPetWindow } from "./shell/DesktopPetWindow";
import "./styles/workbench.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Tinybot React root was not found.");
}

const surface = new URLSearchParams(window.location.search).get("surface");

if (surface === "desktop-pet") {
  document.documentElement.dataset.surface = "desktop-pet";
  createRoot(root).render(<DesktopPetApp />);
} else {
  createRoot(root).render(<App />);
}

function DesktopPetApp() {
  useEffect(() => installRendererDiagnosticHandlers(), []);
  return (
    <TinybotErrorBoundary>
      <AppLanguageProvider>
        <AppAppearanceProvider>
          <DesktopPetWindow />
        </AppAppearanceProvider>
      </AppLanguageProvider>
    </TinybotErrorBoundary>
  );
}
