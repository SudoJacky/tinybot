export type DesktopAgentRoute = "gateway" | "ts-agent";

export function resolveDesktopAgentRoute({
  search,
  storedRoute,
}: {
  search: string;
  storedRoute: string | null | undefined;
}): DesktopAgentRoute {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const route = params.get("agentRoute") || params.get("desktopAgentRoute") || storedRoute || "";
  return route === "ts-agent" ? "ts-agent" : "gateway";
}
