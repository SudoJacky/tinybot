import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/workbench.css";

const root = document.querySelector("#root");

if (!root) {
  throw new Error("Tinybot React root was not found.");
}

createRoot(root).render(<App />);
