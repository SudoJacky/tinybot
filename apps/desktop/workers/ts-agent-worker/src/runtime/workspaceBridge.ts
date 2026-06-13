import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type {
  WebuiWorkspaceFileContent,
  WebuiWorkspaceFileEntry,
  WebuiWorkspaceProvider,
  WebuiWorkspaceWriteResult,
} from "../webui/webuiRoutes.ts";

export class NativeWorkspaceBridge implements WebuiWorkspaceProvider {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async listFiles(traceId: string): Promise<WebuiWorkspaceFileEntry[]> {
    const result = await this.rpcClient.request(traceId, "workspace.list_files", {});
    const entries = Array.isArray(result) ? result : [];
    return entries.map(normalizeWorkspaceFileEntry).filter((entry): entry is WebuiWorkspaceFileEntry => entry !== null);
  }

  async readFile(path: string, traceId: string): Promise<WebuiWorkspaceFileContent | null> {
    const result = asObject(await this.rpcClient.request(traceId, "workspace.read_file", { path, format: "raw" }));
    if (!result) {
      return null;
    }
    const resolvedPath = asString(result.path) ?? path;
    const content = asString(result.content) ?? asString(result.contents);
    if (content === undefined) {
      return null;
    }
    return {
      path: resolvedPath,
      content,
      exists: true,
      updatedAt: asString(result.updated_at) ?? asString(result.updatedAt) ?? null,
    };
  }

  async writeFile(
    path: string,
    contents: string,
    traceId: string,
    expectedUpdatedAt?: string | null,
  ): Promise<WebuiWorkspaceWriteResult> {
    const params: Record<string, unknown> = { path, contents };
    if (expectedUpdatedAt !== undefined) {
      params.expected_updated_at = expectedUpdatedAt;
    }
    const result = asObject(await this.rpcClient.request(traceId, "workspace.write_file", params));
    return {
      path: asString(result?.path) ?? path,
      updatedAt: asString(result?.updated_at) ?? asString(result?.updatedAt) ?? null,
    };
  }
}

function normalizeWorkspaceFileEntry(value: unknown): WebuiWorkspaceFileEntry | null {
  const object = asObject(value);
  const path = asString(object?.path);
  if (!path) {
    return null;
  }
  return {
    path,
    exists: true,
    updatedAt: asString(object?.updated_at) ?? asString(object?.updatedAt) ?? null,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
