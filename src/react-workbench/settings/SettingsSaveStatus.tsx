import { Check, Loader2 } from "lucide-react";

export type SettingsSaveState = "error" | "idle" | "notice" | "saved" | "saving";

export function SettingsSaveStatus({
  message,
  state,
}: {
  message: string | null;
  state: SettingsSaveState;
}) {
  return (
    <p
      aria-hidden={state === "idle" ? "true" : undefined}
      className="react-settings-save-status"
      data-state={state}
      role={state === "error" ? "alert" : "status"}
    >
      <span aria-hidden="true" className="react-settings-save-status__icon">
        <Loader2 data-icon="saving" size={14} />
        <Check data-icon="saved" size={14} />
      </span>
      {message ? (
        <span className="react-settings-save-status__message" key={message}>{message}</span>
      ) : null}
    </p>
  );
}
