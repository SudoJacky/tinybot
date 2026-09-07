import type { AgentInputReference } from "./agentInputReference";

export type OfficeContentSelection = {
  kind: "document" | "presentation";
  start: number;
  end: number;
  text: string;
  context: string;
  wholeSlide?: boolean;
};
export type OfficeContentChangeRequest = OfficeContentSelection & { instruction: string };

export function officeContentReference({ request, path, title, threadId, revision, label }: {
  request: OfficeContentChangeRequest; path: string; title: string; threadId: string; revision: string; label: string;
}): AgentInputReference {
  const position = request.start === request.end ? String(request.start) : `${request.start}-${request.end}`;
  return {
    kind: "reference", referenceKind: "file", title, sourcePath: path, scope: threadId, revision,
    detail: `${label} · ${request.instruction}`,
    sourceText: [
      `File: ${path}`, `Viewed revision: ${revision}`,
      request.kind === "document" ? `Word preview paragraphs: ${position}` : `PowerPoint slides: ${position}`,
      request.wholeSlide ? "Selection: entire slide (quoted text may be empty for a visual slide)." : "Selection: quoted text.",
      "Verify the current source file before editing. Preview paragraph positions are not XML indices. Locate the quoted text using its surrounding context; do not replace every matching occurrence.",
      `Selected text:\n${excerpt(request.text)}`,
      `Surrounding content:\n${excerpt(request.context)}`,
      `Requested change:\n${request.instruction}`,
    ].join("\n\n"),
  };
}

function excerpt(text: string): string {
  return text.length > 12_000 ? text.slice(0, 12_000) + "\n[Excerpt truncated; read the original file for the complete selection.]" : text;
}
