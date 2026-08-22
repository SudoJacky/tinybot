import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { installRendererDiagnosticHandlers } from "../app-core/native/rendererDiagnostics";
import { App, TinybotErrorBoundary } from "./App";
import { createDesktopAppServices } from "./defaultServices";
import { AppAppearanceProvider } from "./settings/AppAppearanceContext";
import { AppLanguageProvider } from "./settings/AppLanguageContext";
import { DesktopPetWindow } from "./shell/DesktopPetWindow";
import { DesktopPetQuickChatWindow } from "./shell/DesktopPetQuickChatWindow";
import "./styles/workbench.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Tinybot React root was not found.");
}

const surface = new URLSearchParams(window.location.search).get("surface");

if (surface === "desktop-pet") {
  document.documentElement.dataset.surface = "desktop-pet";
  createRoot(root).render(<DesktopPetApp />);
} else if (surface === "desktop-pet-chat") {
  document.documentElement.dataset.surface = "desktop-pet-chat";
  createRoot(root).render(<DesktopPetQuickChatApp />);
} else {
  createRoot(root).render(<App />);
}

function DesktopPetQuickChatApp() {
  const services = useMemo(() => createDesktopAppServices(), []);
  useEffect(() => installRendererDiagnosticHandlers(), []);
  return (
    <TinybotErrorBoundary>
      <AppLanguageProvider>
        <AppAppearanceProvider>
          <DesktopPetQuickChatWindow services={services} />
        </AppAppearanceProvider>
      </AppLanguageProvider>
    </TinybotErrorBoundary>
  );
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
