import type { JsonObject } from "../protocol/messages.ts";

export const ADAPTIVE_STARTER = "adaptive_starter";

export const CANONICAL_ARCHITECTURES = new Set([
  ADAPTIVE_STARTER,
  "supervisor",
  "orchestrator",
  "team",
  "generator_verifier",
  "message_bus",
  "shared_state",
  "peer_handoff",
  "swarm",
]);

const LEGACY_ARCHITECTURE_ALIASES: Record<string, string> = {
  hybrid: ADAPTIVE_STARTER,
};

const ARCHITECTURE_LABELS: Record<string, string> = {
  [ADAPTIVE_STARTER]: "Adaptive Starter",
  supervisor: "Supervisor",
  orchestrator: "Orchestrator",
  team: "Agent Team",
  generator_verifier: "Generator-Verifier",
  message_bus: "Message Bus",
  shared_state: "Shared State",
  peer_handoff: "Peer Handoff",
  swarm: "Swarm",
};

export function normalizeArchitectureName(value: unknown): string {
  const name = String(value || ADAPTIVE_STARTER).trim().toLowerCase().replace(/-/g, "_");
  const canonical = LEGACY_ARCHITECTURE_ALIASES[name] ?? name;
  return CANONICAL_ARCHITECTURES.has(canonical) ? canonical : ADAPTIVE_STARTER;
}

export function architectureLabel(value: unknown): string {
  return ARCHITECTURE_LABELS[normalizeArchitectureName(value)] ?? "Adaptive Starter";
}

export function architectureFallbackDiagnostic(value: unknown, options: { path?: string } = {}): JsonObject | null {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const name = raw.toLowerCase().replace(/-/g, "_");
  if (CANONICAL_ARCHITECTURES.has(name) || LEGACY_ARCHITECTURE_ALIASES[name]) {
    return null;
  }
  return {
    severity: "warning",
    code: "unknown_architecture_fallback",
    message: `Unknown Cowork architecture '${raw}' was normalized to '${ADAPTIVE_STARTER}'.`,
    path: options.path ?? "workflow_mode",
    value: raw,
  };
}
