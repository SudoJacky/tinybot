import type { DetailPanelState } from "./chatUiProjection";

export type ChatDetailPanelKind = Exclude<DetailPanelState["kind"], "none">;

export function openChatDetailPanel(
  kind: ChatDetailPanelKind,
  targetId: string,
  viewportWidth: number,
): DetailPanelState {
  return {
    kind,
    open: true,
    presentation: resolveChatDetailPresentation(viewportWidth),
    targetId,
  };
}

export function closeChatDetailPanel(viewportWidth = 720): DetailPanelState {
  return {
    kind: "none",
    open: false,
    presentation: resolveChatDetailPresentation(viewportWidth),
  };
}

export function resolveChatDetailPresentation(viewportWidth: number): DetailPanelState["presentation"] {
  return viewportWidth < 720 ? "fullscreen" : "drawer";
}
