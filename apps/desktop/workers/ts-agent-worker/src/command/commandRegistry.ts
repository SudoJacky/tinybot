import { CommandRouter } from "./commandRouter.ts";
import type { CommandCapabilities, CommandContext, CommandResult } from "./commandTypes.ts";

const HELP_COMMANDS = [
  { command: "/new", description: "Start a new conversation." },
  { command: "/stop", description: "Stop the current task." },
  { command: "/restart", description: "Restart the backend worker." },
  { command: "/status", description: "Show worker and session status." },
  { command: "/dream", description: "Manually trigger Dream consolidation." },
  { command: "/dream-log [sha]", description: "Show Dream memory changes." },
  { command: "/dream-restore [sha]", description: "List or restore Dream memory versions." },
  { command: "/approvals", description: "List pending approval requests." },
  { command: "/approve <id> once|session", description: "Approve a pending request." },
  { command: "/deny <id>", description: "Deny a pending request." },
  { command: "/help", description: "Show available backend slash commands." },
];

export function createDefaultCommandRouter(capabilities: CommandCapabilities = {}): CommandRouter {
  const router = new CommandRouter();
  router.priority("/stop", (context) => stopResult(context, capabilities));
  router.priority("/status", (context) => statusResult(context, capabilities));
  router.priority("/restart", (context) => restartResult(context, capabilities));
  router.exact("/new", (context) => newSessionResult(context, capabilities));
  router.exact("/approvals", (context) => approvalsResult(context, capabilities));
  router.prefix("/approve", (context) => approveResult(context, capabilities));
  router.prefix("/deny", (context) => denyResult(context, capabilities));
  router.exact("/dream", (context) => dreamResult(context, capabilities));
  router.exact("/dream-log", (context) => dreamLogResult(context, capabilities));
  router.prefix("/dream-log", (context) => dreamLogResult(context, capabilities));
  router.exact("/dream-restore", (context) => dreamRestoreResult(context, capabilities));
  router.prefix("/dream-restore", (context) => dreamRestoreResult(context, capabilities));
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

async function newSessionResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  if (!context.sessionId || !capabilities.clearSession) {
    return {
      handled: true,
      output: "New session is unavailable in this runtime.",
      metadata: {
        command: "/new",
        render_as: "text",
        cleared: false,
      },
    };
  }
  const result = await capabilities.clearSession(context.sessionId, context.traceId);
  return {
    handled: true,
    output: "New session started.",
    metadata: {
      command: "/new",
      render_as: "text",
      cleared: true,
      session_id: result.sessionId,
      messages_before: result.messagesBefore,
      messages_after: result.messagesAfter,
      checkpoint_cleared: result.checkpointCleared,
    },
  };
}

async function approvalsResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  const result = context.sessionId && capabilities.listPendingApprovals
    ? await capabilities.listPendingApprovals(context.sessionId, context.traceId)
    : { approvals: [] };
  const approvals = Array.isArray(result.approvals) ? result.approvals : [];
  return {
    handled: true,
    output: formatPendingApprovals(approvals),
    metadata: {
      command: "/approvals",
      render_as: "text",
      pending_count: approvals.length,
    },
  };
}

function formatPendingApprovals(approvals: Array<{
  id: string;
  summary: string;
  risk: string;
  category: string;
  reason: string;
}>): string {
  if (approvals.length === 0) {
    return "No pending approvals.";
  }
  return [
    "## Pending Approvals",
    "",
    ...approvals.flatMap((item) => [
      `- \`${item.id}\` ${item.summary}`,
      `  Risk: ${item.risk} (${item.category})`,
      `  Reason: ${item.reason}`,
    ]),
    "",
    "Approve once: `/approve <id> once`",
    "Allow for this session: `/approve <id> session`",
    "Deny: `/deny <id>`",
  ].join("\n");
}

async function approveResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  const parts = commandArgs(context);
  if (parts.length !== 2 || (parts[1] !== "once" && parts[1] !== "session")) {
    return textCommandResult("/approve", "Usage: `/approve <id> once` or `/approve <id> session`.", {
      approved: false,
      resolved: false,
    });
  }
  if (!context.sessionId || !capabilities.resolvePendingApproval) {
    return textCommandResult("/approve", "Approval actions are unavailable in this runtime.", {
      approved: false,
      resolved: false,
    });
  }
  const [approvalId, scope] = parts as [string, "once" | "session"];
  const resolution = await capabilities.resolvePendingApproval({
    traceId: context.traceId,
    sessionId: context.sessionId,
    approvalId,
    approved: true,
    scope,
  });
  if (!resolution.resolved) {
    return approvalNotFoundResult("/approve", approvalId, true, scope);
  }
  const summary = resolution.summary ?? approvalId;
  const output = scope === "once"
    ? `Approved \`${resolution.approvalId}\` once: ${summary}\n\nRetrying the approved operation now.`
    : `Approved \`${resolution.approvalId}\` for this session: ${summary}\n\nMatching operations in this session will not ask again. Retrying now.`;
  return textCommandResult("/approve", output, {
    approval_id: resolution.approvalId,
    approved: true,
    resolved: true,
    scope,
  });
}

async function denyResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  const approvalId = commandArgs(context)[0] ?? "";
  if (!approvalId) {
    return textCommandResult("/deny", "Usage: `/deny <id>`.", {
      approved: false,
      resolved: false,
    });
  }
  if (!context.sessionId || !capabilities.resolvePendingApproval) {
    return textCommandResult("/deny", "Approval actions are unavailable in this runtime.", {
      approval_id: approvalId,
      approved: false,
      resolved: false,
    });
  }
  const resolution = await capabilities.resolvePendingApproval({
    traceId: context.traceId,
    sessionId: context.sessionId,
    approvalId,
    approved: false,
  });
  if (!resolution.resolved) {
    return approvalNotFoundResult("/deny", approvalId, false);
  }
  return textCommandResult("/deny", `Denied \`${resolution.approvalId}\`: ${resolution.summary ?? resolution.approvalId}`, {
    approval_id: resolution.approvalId,
    approved: false,
    resolved: true,
  });
}

async function dreamResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  if (!capabilities.runDream) {
    return unavailableDreamResult("/dream");
  }
  const result = await capabilities.runDream({
    traceId: context.traceId,
    sessionId: context.sessionId,
  });
  return textCommandResult("/dream", result.content, result.metadata);
}

async function dreamLogResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  if (!capabilities.getDreamLog) {
    return unavailableDreamResult("/dream-log");
  }
  const result = await capabilities.getDreamLog({
    traceId: context.traceId,
    sessionId: context.sessionId,
    ...firstArgMetadata(context),
  });
  return textCommandResult("/dream-log", result.content, result.metadata);
}

async function dreamRestoreResult(context: CommandContext, capabilities: CommandCapabilities): Promise<CommandResult> {
  if (!capabilities.restoreDream) {
    return unavailableDreamResult("/dream-restore");
  }
  const result = await capabilities.restoreDream({
    traceId: context.traceId,
    sessionId: context.sessionId,
    ...firstArgMetadata(context),
  });
  return textCommandResult("/dream-restore", result.content, result.metadata);
}

function unavailableDreamResult(command: "/dream" | "/dream-log" | "/dream-restore"): CommandResult {
  return textCommandResult(command, "Dream commands are unavailable in this runtime.", {
    available: false,
  });
}

function commandArgs(context: CommandContext): string[] {
  return context.args.trim().split(/\s+/).filter(Boolean);
}

function firstArgMetadata(context: CommandContext): { sha?: string } {
  const sha = commandArgs(context)[0];
  return sha ? { sha } : {};
}

function approvalNotFoundResult(
  command: "/approve" | "/deny",
  approvalId: string,
  approved: boolean,
  scope?: "once" | "session",
): CommandResult {
  return textCommandResult(command, `Approval \`${approvalId}\` was not found. Use \`/approvals\` to list pending requests.`, {
    approval_id: approvalId,
    approved,
    resolved: false,
    ...(scope ? { scope } : {}),
  });
}

function textCommandResult(command: string, output: string, metadata: Record<string, unknown> = {}): CommandResult {
  return {
    handled: true,
    output,
    metadata: {
      command,
      render_as: "text",
      ...metadata,
    },
  };
}
