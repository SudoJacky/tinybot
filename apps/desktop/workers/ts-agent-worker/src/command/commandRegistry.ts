import { CommandRouter } from "./commandRouter.ts";
import type { CommandResult } from "./commandTypes.ts";

const HELP_COMMANDS = [
  { command: "/help", description: "Show available backend slash commands." },
  { command: "/status", description: "Show worker and session status." },
  { command: "/stop", description: "Cancel an active run." },
  { command: "/restart", description: "Restart the backend worker." },
];

export function createDefaultCommandRouter(): CommandRouter {
  const router = new CommandRouter();
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
