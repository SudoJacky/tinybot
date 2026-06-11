import { CommandRouter } from "./commandRouter.ts";
import type { CommandCapabilities, CommandContext, CommandResult } from "./commandTypes.ts";

const HELP_COMMANDS = [
  { command: "/help", description: "Show available backend slash commands." },
  { command: "/status", description: "Show worker and session status." },
  { command: "/stop", description: "Cancel an active run." },
  { command: "/restart", description: "Restart the backend worker." },
];

export function createDefaultCommandRouter(capabilities: CommandCapabilities = {}): CommandRouter {
  const router = new CommandRouter();
  router.priority("/stop", (context) => stopResult(context, capabilities));
  router.priority("/status", (context) => statusResult(context, capabilities));
  router.priority("/restart", (context) => restartResult(context, capabilities));
  router.exact("/help", () => helpResult());
  return router;
}

function helpResult(): CommandResult {
  return {
    handled: true,
    output: [
      "Available commands:",
      ...HELP_COMMANDS.map((entry) => `${entry.command} - ${entry.description}`),
    ].join("\n"),
    metadata: {
      command: "/help",
      render_as: "text",
      commands: HELP_COMMANDS,
    },
  };
}

async function stopResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  const result = (await capabilities.cancelActiveRunsForSession?.(context.sessionId))
    ?? { cancelledCount: 0, runIds: [] };
  const output = result.cancelledCount > 0
    ? `Stopped ${result.cancelledCount} task(s).`
    : "No active task to stop.";
  return {
    handled: true,
    output,
    metadata: {
      command: "/stop",
      render_as: "text",
      cancelled_count: result.cancelledCount,
      run_ids: result.runIds,
    },
  };
}

async function statusResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  const snapshot = (await capabilities.getStatusSnapshot?.(context)) ?? {
    activeRunCount: 0,
    activeSessionRunCount: 0,
    sessionId: context.sessionId,
  };
  return {
    handled: true,
    output: [
      "Worker status:",
      `Active runs: ${snapshot.activeRunCount}`,
      `Current session active runs: ${snapshot.activeSessionRunCount}`,
      ...(snapshot.sessionId ? [`Session: ${snapshot.sessionId}`] : []),
    ].join("\n"),
    metadata: {
      command: "/status",
      render_as: "text",
      active_run_count: snapshot.activeRunCount,
      active_session_run_count: snapshot.activeSessionRunCount,
      ...(snapshot.sessionId ? { session_id: snapshot.sessionId } : {}),
    },
  };
}

async function restartResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  if (!capabilities.requestRestart) {
    return {
      handled: true,
      output: "Restart is unavailable in this runtime.",
      metadata: {
        command: "/restart",
        render_as: "text",
        restart_requested: false,
      },
    };
  }
  await capabilities.requestRestart({
    traceId: context.traceId,
    runId: context.runId,
    sessionId: context.sessionId,
  });
  return {
    handled: true,
    output: "Restarting...",
    metadata: {
      command: "/restart",
      render_as: "text",
      restart_requested: true,
    },
  };
}
