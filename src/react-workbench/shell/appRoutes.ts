export type ActiveAppRoute = "chat" | "automations" | "graphs" | "memory" | "tools" | "settings" | "performanceTrace";
// Old navigation state can still contain Teams; its durable runs are available
// from Chat history, so resolve it without mounting the retired route.
export type AppRoute = ActiveAppRoute | "teams";
export function resolveAppRoute(route: AppRoute): ActiveAppRoute {
  return route === "teams" ? "chat" : route;
}
