export type AgentInputReference = {
  kind: "browser" | "recent" | "reference";
  title: string;
  detail: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  sourceText?: string;
  rawPath?: string;
  rawLine?: number;
  noteId?: string;
  evidenceId?: string;
  scope?: string;
  type?: string;
  revision?: string;
};
