import type { TinyOsAppId } from "./tinyOsDesktopModel";

export type TinyOsShellCommandId =
  | "agent.cancel"
  | "agent.pause"
  | "agent.resume"
  | "browser.click"
  | "browser.navigate"
  | "browser.type"
  | "history.return_live"
  | "shell.close"
  | "shell.expanded_toggle"
  | "shell.notification_center"
  | "shell.overview"
  | "shell.palette"
  | "shell.reset_layout"
  | "shell.workspace_toggle"
  | "terminal.cancel"
  | "terminal.execute"
  | `app.open:${TinyOsAppId}`
  | `evidence.inspect:${string}`
  | `history.select:${string}`
  | `notification.open:${string}`
  | `notification.read:${string}`
  | `operation.retry:${string}`
  | `process.inspect:${string}`
  | `process.reveal:${string}`
  | `reference.attach:${string}`
  | `resource.reveal:${string}`
  | `window.focus:${TinyOsAppId}`
  | `window.maximize:${TinyOsAppId}`
  | `window.minimize:${TinyOsAppId}`;

export type TinyOsShellCommandTarget =
  | { appId: TinyOsAppId; kind: "application" }
  | { appId: TinyOsAppId; kind: "window" }
  | { itemId: string; kind: "evidence"; turnId?: string }
  | { itemId: string; kind: "history"; turnId: string }
  | { itemId: string; kind: "operation"; turnId: string }
  | { kind: "process"; processId: string }
  | { kind: "resource"; resourceId: string }
  | { kind: "turn"; turnId: string }
  | { kind: "shell" };

export type TinyOsShellCommandInputSchema =
  | { kind: "none" }
  | { fields: readonly { label: string; name: string; required: boolean }[]; kind: "fields" }
  | { kind: "text"; label: string; required: boolean }
  | { acceptedKinds: readonly string[]; kind: "reference" };

export type TinyOsShellCommandInput = Readonly<Record<string, string>> | string | undefined;

export type TinyOsShellCommandAvailability =
  | { available: true }
  | { available: false; reason: string; reasonCode?: string };

export type TinyOsShellCommand<TTarget extends TinyOsShellCommandTarget = TinyOsShellCommandTarget> = {
  availability: TinyOsShellCommandAvailability;
  category: "application" | "history" | "operation" | "process" | "resource" | "system" | "window";
  dispatch(target: TTarget, input?: TinyOsShellCommandInput): void | Promise<void>;
  id: TinyOsShellCommandId;
  input: TinyOsShellCommandInputSchema;
  keywords: readonly string[];
  label: string;
  scope: "local_presentation" | "runtime";
  target: TTarget;
};

export type TinyOsShellCommandExecution =
  | { commandId: TinyOsShellCommandId; status: "executed" }
  | { commandId: TinyOsShellCommandId; reason: string; reasonCode?: string; status: "rejected" };

export type TinyOsShellCommandRegistry = {
  commands: readonly TinyOsShellCommand[];
  execute: (id: TinyOsShellCommandId, input?: TinyOsShellCommandInput) => Promise<TinyOsShellCommandExecution>;
  get: (id: TinyOsShellCommandId) => TinyOsShellCommand | undefined;
};

export type TinyOsShellCommandRegistryOptions = {
  simulationMode?: "history" | "live";
};

export function defineTinyOsShellCommand<TTarget extends TinyOsShellCommandTarget>(
  command: TinyOsShellCommand<TTarget>,
): TinyOsShellCommand<TTarget> {
  const label = command.label.trim();
  if (!label) throw new Error(`TinyOS shell command ${command.id} requires an accessible label.`);
  if (!command.availability.available && !command.availability.reason.trim()) {
    throw new Error(`TinyOS shell command ${command.id} is unavailable without a reason.`);
  }
  if (command.input.kind === "reference" && !command.input.acceptedKinds.length) {
    throw new Error(`TinyOS shell command ${command.id} reference input requires at least one accepted kind.`);
  }
  if (command.input.kind === "fields" && !command.input.fields.length) {
    throw new Error(`TinyOS shell command ${command.id} field input requires at least one field.`);
  }
  return {
    ...command,
    label,
    keywords: uniqueSearchTerms(command.keywords),
  };
}

export function createTinyOsShellCommandRegistry(
  commands: readonly TinyOsShellCommand[],
  options: TinyOsShellCommandRegistryOptions = {},
): TinyOsShellCommandRegistry {
  const byId = new Map<TinyOsShellCommandId, TinyOsShellCommand>();
  for (const sourceCommand of commands) {
    const command = options.simulationMode === "history" && sourceCommand.scope === "runtime"
      ? {
          ...sourceCommand,
          availability: {
            available: false as const,
            reason: "History snapshots are read-only.",
            reasonCode: "history_read_only",
          },
        }
      : sourceCommand;
    if (byId.has(command.id)) throw new Error(`Duplicate TinyOS shell command id: ${command.id}`);
    byId.set(command.id, command);
  }
  const registered = [...byId.values()];
  return {
    commands: registered,
    execute: async (id, input) => {
      const command = byId.get(id);
      if (!command) throw new Error(`Unknown TinyOS shell command: ${id}`);
      return executeTinyOsShellCommand(command, input);
    },
    get: (id) => byId.get(id),
  };
}

export async function executeTinyOsShellCommand(
  command: TinyOsShellCommand,
  input?: TinyOsShellCommandInput,
): Promise<TinyOsShellCommandExecution> {
  if (!command.availability.available) {
    return {
      commandId: command.id,
      reason: command.availability.reason,
      ...(command.availability.reasonCode ? { reasonCode: command.availability.reasonCode } : {}),
      status: "rejected",
    };
  }
  validateTinyOsShellCommandInput(command, input);
  await command.dispatch(command.target, input);
  return { commandId: command.id, status: "executed" };
}

function validateTinyOsShellCommandInput(command: TinyOsShellCommand, input?: TinyOsShellCommandInput): void {
  if (command.input.kind === "none" || command.input.kind === "reference") return;
  if (command.input.kind === "text") {
    if (command.input.required && (typeof input !== "string" || !input.trim())) {
      throw new Error(`TinyOS shell command ${command.id} requires ${command.input.label}.`);
    }
    return;
  }
  if (!input || typeof input === "string") {
    throw new Error(`TinyOS shell command ${command.id} requires structured input.`);
  }
  for (const field of command.input.fields) {
    if (field.required && !input[field.name]?.trim()) {
      throw new Error(`TinyOS shell command ${command.id} requires ${field.label}.`);
    }
  }
}

function uniqueSearchTerms(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean))];
}
