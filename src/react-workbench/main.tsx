import { createRoot } from "react-dom/client";
import { createDesktopNativeStartupTrace } from "../app-core/native/desktopNativeChatDebug";
import { App } from "./App";
import "./styles/workbench.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Tinybot React root was not found.");
const startupTrace = createDesktopNativeStartupTrace({ startedAt: 0 });
startupTrace.mark("renderer.ready", { surface: "main" });
startupTrace.start("react.commit");
createRoot(root).render(<App startupTrace={startupTrace} />);
