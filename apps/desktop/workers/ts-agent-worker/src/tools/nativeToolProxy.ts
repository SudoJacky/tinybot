import type { JsonObject } from "../protocol/messages.ts";
import type { Tool } from "./tool.ts";

export type NativeRpcClient = {
  request(traceId: string, method: string, params: JsonObject): Promise<unknown>;
};

export function createNativeReadOnlyTools(rpcClient: NativeRpcClient): Tool[] {
  return [createReadFileTool(rpcClient), createListDirTool(rpcClient)];
}

function createReadFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a workspace file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The workspace-relative file path to read" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.read_file", { path });
      const file = asObject(result);
      const contents = file && typeof file.contents === "string" ? file.contents : "";
      return { content: contents };
    },
  };
}

function createListDirTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "list_dir",
    description: "List workspace files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Ignored for now; the native gateway lists the active workspace" },
      },
    },
    execute: async (_args, context) => {
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.list_files", {});
      const entries = Array.isArray(result) ? result : [];
      return {
        content: entries
          .map((entry) => {
            const object = asObject(entry);
            return typeof object?.path === "string" ? object.path : null;
          })
          .filter((path): path is string => path !== null)
          .join("\n"),
      };
    },
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function requireTraceId(traceId: string | undefined): string {
  if (!traceId) {
    throw new Error("native tool requires traceId");
  }
  return traceId;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
