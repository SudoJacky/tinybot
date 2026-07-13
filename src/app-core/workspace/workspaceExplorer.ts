export type WorkspaceDirectoryRequest = {
  cursor?: string;
  nameQuery?: string;
  path: string;
};

export type WorkspaceDirectoryEntry = {
  kind: "directory" | "file";
  name: string;
  path: string;
  sizeBytes?: number;
  updatedAt?: string;
};

export type WorkspaceDirectoryPage = {
  entries: WorkspaceDirectoryEntry[];
  listingRevision: string;
  nextCursor?: string;
  path: string;
  workspaceKey?: string;
};

export type WorkspaceFileChunk = {
  content?: string;
  contentType: "text" | "binary" | "unsupported";
  lineEnd?: number;
  lineStart?: number;
  nextCursor?: string;
  path: string;
  revision: string;
  sizeBytes: number;
  updatedAt?: string;
};

export type WorkspaceQueryErrorCode =
  | "not_configured"
  | "capability_denied"
  | "root_unavailable"
  | "invalid_path"
  | "not_found"
  | "not_directory"
  | "listing_changed"
  | "source_changed"
  | "io_error";

export type WorkspaceQueryError = Error & {
  code: WorkspaceQueryErrorCode;
  path?: string;
  retryable: boolean;
};
