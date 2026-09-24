import { createContext } from "react";
import type { TeamRun } from "../../app-core/native/desktopNativeTeams";

export const ChatTeamContext = createContext<{
  run?: TeamRun;
  selectedTaskId?: string;
  open(run: TeamRun, taskId: string, trigger: HTMLButtonElement): void;
} | null>(null);
