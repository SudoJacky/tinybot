import { useMemo } from "react";
import { createDesktopAppServices } from "./defaultServices";
import { DesktopShell } from "./shell/DesktopShell";

export function App() {
  const services = useMemo(() => createDesktopAppServices(), []);
  return <DesktopShell services={services} />;
}
