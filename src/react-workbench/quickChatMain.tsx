import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { installRendererDiagnosticHandlers } from "../app-core/native/rendererDiagnostics";
import { TinybotErrorBoundary } from "./TinybotErrorBoundary";
import { AppAppearanceProvider } from "./settings/AppAppearanceContext";
import { AppLanguageProvider } from "./settings/AppLanguageContext";
import { removeStartupSplash } from "./startupSplash";
import "./styles/workbench.css";
import { DesktopPetQuickChatWindow } from "./shell/DesktopPetQuickChatWindow";
import { createDesktopAppServices } from "./defaultServices";

const root = document.querySelector("#root");
if (!root) throw new Error("Tinybot React root was not found.");
removeStartupSplash();
document.documentElement.dataset.surface = "desktop-pet-chat";
createRoot(root).render(<DesktopPetQuickChatApp />);

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
