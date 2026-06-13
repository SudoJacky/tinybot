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
  running: boolean;
  lastResult: HeartbeatTickResult | null;
  lastError: string | null;
};
