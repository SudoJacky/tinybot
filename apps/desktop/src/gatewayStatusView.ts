import type { GatewayHealth } from "./gatewayHttpClient";

export type GatewayRuntimeSnapshot = {
  state: "running" | "starting" | "offline" | "failed";
  owner: "shell" | "external" | "none";
  http_ok: boolean;
};

export type GatewayStatusView = {
  statusText: string;
  hostedReady: boolean;
  nativeReady: boolean;
  dotState: "ok" | "warn" | "idle";
  detailText: string;
};

export function resolveGatewayStatusView(
  health: GatewayHealth,
  runtimeStatus: GatewayRuntimeSnapshot | null,
): GatewayStatusView {
  const shellReachable = runtimeStatus?.http_ok === true || runtimeStatus?.state === "running";
  if (health.state === "running") {
    return {
      statusText: "Running",
      hostedReady: true,
      nativeReady: true,
      dotState: "ok",
      detailText: "Ready",
    };
  }
  if (health.state === "degraded") {
    return {
      statusText: "HTTP only",
      hostedReady: true,
      nativeReady: false,
      dotState: "idle",
      detailText: "HTTP is reachable but WebSocket health failed.",
    };
  }
  if (shellReachable) {
    return {
      statusText: "Reachable (API health failed)",
      hostedReady: true,
      nativeReady: false,
      dotState: "idle",
      detailText: "The desktop shell can reach the gateway, but the frontend API/WebSocket health check failed.",
    };
  }
  return {
    statusText: "Offline",
    hostedReady: false,
    nativeReady: false,
    dotState: "warn",
    detailText: "Gateway offline",
  };
}
