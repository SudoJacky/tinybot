import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { installRendererDiagnosticHandlers } from "../app-core/native/rendererDiagnostics";
import { TinybotErrorBoundary } from "./TinybotErrorBoundary";
import { AppAppearanceProvider } from "./settings/AppAppearanceContext";
import { AppLanguageProvider } from "./settings/AppLanguageContext";
import { removeStartupSplash } from "./startupSplash";
import "./styles/workbench.css";
import { DesktopPetWindow } from "./shell/DesktopPetWindow";

const root = document.querySelector("#root");
if (!root) throw new Error("Tinybot React root was not found.");
removeStartupSplash();
document.documentElement.dataset.surface = "desktop-pet";
createRoot(root).render(<DesktopPetApp />);

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
