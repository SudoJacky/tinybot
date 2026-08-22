import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import type { DesktopPetMood } from "../../app-core/desktop-pet/desktopPetState";
import type { SessionSummary } from "../services";
import "./TinybotMascot.css";

export type TinybotMascotMood = DesktopPetMood;

export type TinybotMascotState = {
  responding: boolean;
  sessionStatus?: SessionSummary["status"];
  turnStatus?: ChatTurn["status"];
};

export function projectTinybotMascotMood({
  responding,
  sessionStatus,
  turnStatus,
}: TinybotMascotState): TinybotMascotMood {
  if (turnStatus === "awaiting_user") return "curious";
  if (turnStatus === "failed" || turnStatus === "interrupted" || sessionStatus === "failed") return "angry";
  if (responding || turnStatus === "pending" || turnStatus === "running" || sessionStatus === "running") return "working";
  if (turnStatus === "completed") return "pleased";
  return "calm";
}

export function TinybotMascot({ label, mood }: { label: string; mood: TinybotMascotMood }) {
  return (
    <div
      aria-atomic="true"
      aria-label={label}
      aria-live="polite"
      className="react-tinybot-mascot"
      data-mood={mood}
      role="img"
      title={label}
    >
      <svg aria-hidden="true" viewBox="0 0 48 48">
        <g className="react-tinybot-mascot__body-pose">
          <g className="react-tinybot-mascot__body-motion">
            <circle className="react-tinybot-mascot__rim" cx="22.8" cy="25.5" r="17.4" />
            <circle className="react-tinybot-mascot__core" cx="22.8" cy="25.5" r="15.5" />
          </g>
        </g>
        <g className="react-tinybot-mascot__eye-pose">
          <circle className="react-tinybot-mascot__eye-motion" cx="17.7" cy="20.4" r="3.7" />
        </g>
        <g className="react-tinybot-mascot__satellite-pose">
          <circle className="react-tinybot-mascot__satellite-motion" cx="40.6" cy="8" r="2.8" />
        </g>
      </svg>
    </div>
  );
}
