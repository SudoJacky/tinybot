import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";

export interface DesktopGatewayRuntimeRow {
  label: string;
  value: string;
}

export type DesktopGatewayRuntimeActionId =
  | "start"
  | "stop"
  | "restart"
  | "retry"
  | "copyDiagnostics"
  | "openLogs";

export interface DesktopGatewayRuntimeAction {
  id: DesktopGatewayRuntimeActionId;
  label: string;
}

export type DesktopGatewayRuntimeCommand = "start_gateway" | "stop_gateway";

export interface DesktopGatewayRuntimeCommandDeps {
  runCommand: (command: DesktopGatewayRuntimeCommand) => Promise<GatewayRuntimeStatus>;
}

const ACTION_LABELS: Record<DesktopGatewayRuntimeActionId, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  retry: "Retry",
  copyDiagnostics: "Copy diagnostics",
  openLogs: "Open logs",
};

export function buildDesktopGatewayRuntimeRows(
  status: GatewayRuntimeStatus | null,
  fallbackGatewayHttp: string,
): DesktopGatewayRuntimeRow[] {
  const gatewayHttp = status?.gateway_http || fallbackGatewayHttp;
  const logs = (status?.logs ?? []).slice(-4);
  return [
    { label: "State", value: formatState(status?.state ?? "running") },
    { label: "Owner", value: formatOwner(status?.owner ?? "external") },
    { label: "Command", value: status?.command || "uv run tinybot gateway" },
    { label: "Port", value: formatPort(status?.port, gatewayHttp) },
    { label: "Repo root", value: status?.repo_root || "Unknown" },
    { label: "Recent logs", value: logs.length ? logs.join("\n") : "No recent logs" },
    { label: "Last error", value: status?.last_error || "No recent error" },
    ...bootstrapRows(status),
    { label: "Exit policy", value: formatExitPolicy(status?.exit_policy, status?.owner ?? "external") },
  ];
}

export function buildDesktopGatewayRuntimeActions(status: GatewayRuntimeStatus | null): DesktopGatewayRuntimeAction[] {
  const owner = status?.owner ?? "external";
  const state = status?.state ?? "running";
  const actions: DesktopGatewayRuntimeActionId[] = [];
  if (owner === "shell") {
    actions.push("stop");
    if (state === "running") {
      actions.push("restart");
    }
  } else if (owner === "none" || state === "offline" || state === "failed") {
    actions.push("start", "retry");
  }
  actions.push("copyDiagnostics", "openLogs");
  return actions.map((id) => ({ id, label: ACTION_LABELS[id] }));
}

export function buildDesktopGatewayRuntimeDiagnostics(
  status: GatewayRuntimeStatus | null,
  fallbackGatewayHttp: string,
): string {
  return buildDesktopGatewayRuntimeRows(status, fallbackGatewayHttp)
    .map((row) => `${row.label}: ${row.value}`)
    .join("\n");
}

export async function runDesktopGatewayRuntimeCommand(
  action: DesktopGatewayRuntimeActionId,
  status: GatewayRuntimeStatus | null,
  deps: DesktopGatewayRuntimeCommandDeps,
): Promise<GatewayRuntimeStatus | null> {
  if (action === "start" || action === "retry") {
    return deps.runCommand("start_gateway");
  }
  if (action === "stop" && status?.owner === "shell") {
    return deps.runCommand("stop_gateway");
  }
  if (action === "restart" && status?.owner === "shell") {
    await deps.runCommand("stop_gateway");
    return deps.runCommand("start_gateway");
  }
  return null;
}

function formatState(state: GatewayRuntimeStatus["state"]): string {
  return state[0].toUpperCase() + state.slice(1);
}

function formatOwner(owner: GatewayRuntimeStatus["owner"]): string {
  if (owner === "shell") {
    return "Shell-owned";
  }
  if (owner === "external") {
    return "External";
  }
  return "None";
}

function formatPort(port: GatewayRuntimeStatus["port"], gatewayHttp: string): string {
  if (port !== undefined && port !== null && String(port).trim()) {
    return String(port);
  }
  try {
    return new URL(gatewayHttp).port || "default";
  } catch {
    return "Unknown";
  }
}

function bootstrapRows(status: GatewayRuntimeStatus | null): DesktopGatewayRuntimeRow[] {
  if (!status?.bootstrap_status && !status?.response_class && !status?.recovery_hint) {
    return [];
  }
  return [
    ...(status.bootstrap_status ? [{ label: "Bootstrap", value: formatBootstrapStatus(status.bootstrap_status) }] : []),
    ...(status.response_class ? [{ label: "Response class", value: status.response_class }] : []),
    ...(status.recovery_hint ? [{ label: "Recovery", value: status.recovery_hint }] : []),
  ];
}

function formatBootstrapStatus(status: string): string {
  return status.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatExitPolicy(policy: GatewayRuntimeStatus["exit_policy"], owner: GatewayRuntimeStatus["owner"]): string {
  if (owner === "external") {
    return "External gateway is not managed by desktop";
  }
  if (policy === "keep_running") {
    return "Keep shell-owned gateway running after exit";
  }
  return "Stop shell-owned gateway on exit";
}
