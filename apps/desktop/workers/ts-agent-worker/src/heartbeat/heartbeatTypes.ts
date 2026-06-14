export type HeartbeatDecision = {
  action: "skip" | "run";
  tasks: string;
};

export type HeartbeatTickResult =
  | { status: "missing_file" }
  | { status: "skipped"; tasks: string }
  | { status: "executed"; tasks: string; response: string }
  | { status: "notified"; tasks: string; response: string }
  | { status: "silenced"; tasks: string; response: string }
  | { status: "failed"; error: string };

export type HeartbeatStatus = {
  enabled: boolean;
  running: boolean;
  executing: boolean;
  intervalMs: number;
  lastResult: HeartbeatTickResult | null;
  lastError: string | null;
};
