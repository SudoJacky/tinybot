export type KnowledgeQueryResult = {
  id: string;
  docId?: string;
  docName: string;
  filePath?: string;
  content: string;
  score?: number;
  lineStart?: number;
  lineEnd?: number;
  page?: number;
  sectionPath?: string;
  retrievalMethod?: string;
};
