import type { Tool } from "./tool.ts";
import type { ToolRegistry } from "./toolRegistry.ts";

export type ToolPolicyOptions = {
  capabilities: Iterable<string>;
  channel?: "agent_ui" | "stdio" | "headless" | string;
};

export function filterToolsByPolicy(tools: Iterable<Tool>, options: ToolPolicyOptions): Tool[] {
  const capabilities = new Set(options.capabilities);
  return Array.from(tools).filter((tool) => toolAllowedByPolicy(tool, capabilities, options.channel));
}

export function registerToolsByPolicy(
  registry: ToolRegistry,
  tools: Iterable<Tool>,
  options: ToolPolicyOptions,
): void {
  for (const tool of filterToolsByPolicy(tools, options)) {
    registry.register(tool);
  }
}

function toolAllowedByPolicy(tool: Tool, capabilities: Set<string>, channel: string | undefined): boolean {
  const requiredCapabilities = tool.capabilities ?? [];
  if (!requiredCapabilities.every((capability) => capabilities.has(capability))) {
    return false;
  }
  if (tool.requiresApproval && !capabilities.has("approval.request")) {
    return false;
  }
  if (requiresInteractiveChannel(tool) && channel !== undefined && channel !== "agent_ui") {
    return false;
  }
  return true;
}

function requiresInteractiveChannel(tool: Tool): boolean {
  return tool.name === "request_form" || tool.name === "request_approval" || tool.requiresApproval === true;
}
