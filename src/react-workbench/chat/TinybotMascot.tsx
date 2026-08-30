import { useId, type CSSProperties } from "react";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import type {
  DesktopPetAppearance,
  DesktopPetMood,
} from "../../app-core/desktop-pet/desktopPetState";
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

export function TinybotMascot({
  appearance = "dimensional",
  label,
  mood,
}: {
  appearance?: DesktopPetAppearance;
  label: string;
  mood: TinybotMascotMood;
}) {
  const paintId = `tinybot-${useId().replace(/:/g, "")}`;
  const dimensional = appearance === "dimensional";
  const gradientFill = (name: string): CSSProperties | undefined => (
    dimensional ? { fill: `url(#${paintId}-${name})` } : undefined
  );

  return (
    <div
      aria-atomic="true"
      aria-label={label}
      aria-live="polite"
      className="react-tinybot-mascot"
      data-appearance={appearance}
      data-mood={mood}
      role="img"
      title={label}
    >
      <svg aria-hidden="true" viewBox="0 0 48 48">
        {dimensional ? (
          <defs>
            <radialGradient cx="31%" cy="24%" id={`${paintId}-rim`} r="76%">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.56" stopColor="#f4f1e9" />
              <stop offset="1" stopColor="#c8c3b8" />
            </radialGradient>
            <radialGradient cx="31%" cy="23%" id={`${paintId}-core`} r="78%">
              <stop offset="0" stopColor="#52524d" />
              <stop offset="0.38" stopColor="#20201e" />
              <stop offset="1" stopColor="#080807" />
            </radialGradient>
            <radialGradient cx="30%" cy="24%" id={`${paintId}-eye`} r="76%">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.64" stopColor="#faf9f5" />
              <stop offset="1" stopColor="#cec8bb" />
            </radialGradient>
            <radialGradient cx="30%" cy="24%" id={`${paintId}-satellite`} r="78%">
              <stop offset="0" stopColor="#ffc8b2" />
              <stop offset="0.42" stopColor="#e78b69" />
              <stop offset="1" stopColor="#a74431" />
            </radialGradient>
          </defs>
        ) : null}
        <g className="react-tinybot-mascot__body-pose">
          <g className="react-tinybot-mascot__body-motion">
            <circle className="react-tinybot-mascot__rim" cx="22.8" cy="25.5" r="17.4" style={gradientFill("rim")} />
            <circle className="react-tinybot-mascot__core" cx="22.8" cy="25.5" r="15.5" style={gradientFill("core")} />
          </g>
        </g>
        <g className="react-tinybot-mascot__eye-pose">
          <circle className="react-tinybot-mascot__eye-motion" cx="17.7" cy="20.4" r="3.7" style={gradientFill("eye")} />
        </g>
        <g className="react-tinybot-mascot__satellite-pose">
          <circle className="react-tinybot-mascot__satellite-motion" cx="40.6" cy="8" r="2.8" style={gradientFill("satellite")} />
        </g>
      </svg>
    </div>
  );
}
