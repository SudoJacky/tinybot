export type ContextReferenceSummary = {
  attachmentKind?: "file" | "image";
  attachmentPreviewPath?: string;
  attachmentPath?: string;
  mimeType?: string;
  id: string;
  kind: string;
  title: string;
  detail?: string;
  presentation?: "attachment" | "context";
  sourcePath?: string;
  sourceLine?: number;
};

export type OptimisticUserMessage = {
  id: string;
  role: "user";
  createdAtMs: number;
  text: string;
  status: "complete";
  contextReferences?: ContextReferenceSummary[];
  selectedSkills?: string[];
};
