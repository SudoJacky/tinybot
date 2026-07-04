export type SessionDeleteState = {
  confirmingSessionId: string;
  confirmedSessionId?: string;
};

export type SessionDeleteAction =
  | { type: "delete-clicked"; sessionId: string }
  | { type: "row-left"; sessionId: string }
  | { type: "session-selected"; sessionId: string };

export function reduceSessionDeleteState(
  state: SessionDeleteState,
  action: SessionDeleteAction,
): Required<SessionDeleteState> {
  if (action.type === "delete-clicked") {
    if (state.confirmingSessionId === action.sessionId) {
      return { confirmingSessionId: "", confirmedSessionId: action.sessionId };
    }
    return { confirmingSessionId: action.sessionId, confirmedSessionId: "" };
  }
  if (action.type === "row-left" && state.confirmingSessionId !== action.sessionId) {
    return { confirmingSessionId: state.confirmingSessionId, confirmedSessionId: "" };
  }
  return { confirmingSessionId: "", confirmedSessionId: "" };
}
