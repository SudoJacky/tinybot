import type { JsonObject } from "../protocol/messages.ts";
import { formatKnowledgeQueryResults, normalizeKnowledgeQueryResults } from "../knowledge/knowledgeFormatting.ts";
import type { ModelProvider } from "../model/provider.ts";
import { NativeTaskStoreBridge } from "../task/taskStoreBridge.ts";
import { TaskPlanner } from "../task/taskPlanner.ts";
import { createTaskTool } from "../task/taskTool.ts";
import type { Tool } from "./tool.ts";

export type NativeRpcClient = {
  request(traceId: string, method: string, params: JsonObject): Promise<unknown>;
};

export function createNativeReadOnlyTools(rpcClient: NativeRpcClient): Tool[] {
  return [createReadFileTool(rpcClient), createListDirTool(rpcClient)];
}

export function createNativeWriteTools(rpcClient: NativeRpcClient): Tool[] {
  return [createWriteFileTool(rpcClient), createEditFileTool(rpcClient), createDeleteFileTool(rpcClient)];
}

export function createNativeShellTools(rpcClient: NativeRpcClient): Tool[] {
  return [createExecTool(rpcClient)];
}

export function createNativeApprovalTools(rpcClient: NativeRpcClient): Tool[] {
  return [createRequestApprovalTool(rpcClient)];
}

export function createNativeFormTools(rpcClient: NativeRpcClient): Tool[] {
  return [createRequestFormTool(rpcClient)];
}

export function createNativeMemoryTools(rpcClient: NativeRpcClient): Tool[] {
  return [
    createSearchMemoryNotesTool(rpcClient),
    createSaveMemoryNoteTool(rpcClient),
    createTraceMemoryNoteTool(rpcClient),
    createRejectMemoryNoteTool(rpcClient),
    createSupersedeMemoryNoteTool(rpcClient),
  ];
}

export function createNativeRagTools(rpcClient: NativeRpcClient): Tool[] {
  return [
    createAddDocumentTool(rpcClient),
    createQueryKnowledgeTool(rpcClient),
    createListDocumentsTool(rpcClient),
    createGetDocumentTool(rpcClient),
    createDeleteDocumentTool(rpcClient),
    createQueryRagTool(rpcClient),
  ];
}

export function createNativeMcpTools(rpcClient: NativeRpcClient): Tool[] {
  return [createCallMcpTool(rpcClient)];
}

export function createNativeTaskTools(
  rpcClient: NativeRpcClient,
  options: { provider?: ModelProvider; model?: string; workspace?: string } = {},
): Tool[] {
  const planner = options.provider
    ? new TaskPlanner({
      provider: options.provider,
      model: options.model,
      workspace: options.workspace,
    })
    : undefined;
  return [createTaskTool({ store: new NativeTaskStoreBridge(rpcClient), planner })];
}

function createReadFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a file. Returns numbered lines. Use offset and limit to paginate through large files.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The workspace-relative file path to read" },
        offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed, default 1)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read (default 2000)" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const offset = optionalIntegerArg(args, "offset");
      const limit = optionalIntegerArg(args, "limit");
      const params: JsonObject = { path, format: "numbered_lines" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.read_file", params);
      const file = asObject(result);
      const contents = typeof file?.content === "string"
        ? file.content
        : typeof file?.contents === "string"
          ? file.contents
          : "";
      return { content: contents };
    },
  };
}

function createListDirTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "list_dir",
    description: "List the contents of a directory. Set recursive=true to explore nested structure.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The workspace-relative directory path to list" },
        recursive: { type: "boolean", description: "Recursively list all files (default false)" },
        max_entries: { type: "integer", minimum: 1, description: "Maximum entries to return (default 200)" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const recursive = optionalBooleanArg(args, "recursive");
      const maxEntries = optionalIntegerArg(args, "max_entries");
      const params: JsonObject = { path };
      if (recursive !== undefined) {
        params.recursive = recursive;
      }
      if (maxEntries !== undefined) {
        params.max_entries = maxEntries;
      }
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.list_dir", params);
      const response = asObject(result);
      const entries = Array.isArray(response?.entries) ? response.entries : Array.isArray(result) ? result : [];
      return {
        content: entries
          .map((entry) => {
            const object = asObject(entry);
            if (typeof object?.path !== "string") {
              return null;
            }
            return object.kind === "dir" && !object.path.endsWith("/") ? `${object.path}/` : object.path;
          })
          .filter((path): path is string => path !== null)
          .join("\n"),
      };
    },
  };
}

function createWriteFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "write_file",
    description: "Write content to a file at the given path. Creates parent directories if needed.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const content = stringArgAllowEmpty(args, "content");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "workspace.write_file", {
        path,
        contents: content,
      })) ?? {};
      const resultPath = asString(result.path) ?? path;
      const bytesWritten = typeof result.bytes_written === "number" ? result.bytes_written : content.length;
      return { content: `Wrote ${bytesWritten} bytes to ${resultPath}.` };
    },
  };
}

function createEditFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "edit_file",
    description: "Edit a file by replacing old_text with new_text. Set replace_all=true to replace every occurrence.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_text", "new_text"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const oldText = stringArgAllowEmpty(args, "old_text");
      const newText = stringArgAllowEmpty(args, "new_text");
      const replaceAll = optionalBooleanArg(args, "replace_all") ?? false;
      const traceId = requireTraceId(context.traceId);
      const file = asObject(await rpcClient.request(traceId, "workspace.read_file", { path, format: "raw" })) ?? {};
      const rawContent = typeof file.content === "string"
        ? file.content
        : typeof file.contents === "string"
          ? file.contents
          : "";
      const edit = applyTextEdit(rawContent, oldText, newText, replaceAll, path);
      if (!edit.ok) {
        return { content: edit.content };
      }
      await rpcClient.request(traceId, "workspace.write_file", { path, contents: edit.content });
      return { content: `Edited ${path}.` };
    },
  };
}

function createDeleteFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "delete_file",
    description: "Delete a file or directory. Directories must be empty unless recursive=true.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const recursive = optionalBooleanArg(args, "recursive") ?? false;
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "workspace.delete_file", {
        path,
        recursive,
      })) ?? {};
      const resultPath = asString(result.path) ?? path;
      const kind = asString(result.kind) ?? "path";
      return { content: `Deleted ${kind} ${resultPath}.` };
    },
  };
}

function createExecTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "exec",
    description: "Execute a shell command in the workspace and return output. Use with caution.",
    exclusive: true,
    capabilities: ["shell.execute"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        working_dir: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: 600 },
      },
      required: ["command"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        command: stringArg(args, "command"),
        restrict_to_workspace: true,
      };
      const workingDir = optionalStringArg(args, "working_dir");
      const timeout = optionalIntegerArg(args, "timeout");
      if (workingDir !== undefined) {
        params.working_dir = workingDir;
      }
      if (timeout !== undefined) {
        params.timeout = timeout;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "shell.execute", params)) ?? {};
      return {
        content: asString(result.content) ?? formatShellResult(result),
        metadata: {
          exitCode: typeof result.exit_code === "number" ? result.exit_code : undefined,
          timedOut: result.timed_out === true,
          blocked: result.blocked === true,
          truncated: result.truncated === true,
        },
      };
    },
  };
}

function createRequestFormTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "request_form",
    description: "Request structured user input through the native Agent UI form renderer.",
    capabilities: ["form.request"],
    parameters: {
      type: "object",
      properties: {
        form: {
          type: "object",
          description: "Agent UI form schema containing form_id, title, and fields.",
        },
        continuation_mode: {
          type: "string",
          enum: ["structured_message", "resume"],
          description: "How the submitted form should continue the conversation.",
        },
      },
      required: ["form"],
    },
    execute: async (args, context) => {
      const form = objectArg(args, "form");
      const continuationMode = optionalStringArg(args, "continuation_mode") ?? "structured_message";
      const params: JsonObject = {
        run_id: context.runId,
        form,
        continuation_mode: continuationMode,
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "form.request", params)) ?? {};
      const { content: rawContent, ...rawMetadata } = result;
      const metadata = {
        awaitingUserInput: true,
        stopReason: "awaiting_form",
        formId: asString(rawMetadata.formId) ?? asString(form.form_id),
        form: asObject(rawMetadata.form) ?? form,
        continuationMode: asString(rawMetadata.continuationMode) ?? continuationMode,
        ...rawMetadata,
      };
      return {
        content: asString(rawContent) ?? `Waiting for form submission${metadata.formId ? `: ${metadata.formId}` : ""}.`,
        metadata,
      };
    },
  };
}

function createRequestApprovalTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "request_approval",
    description: "Request user approval for a pending native operation before it is executed.",
    capabilities: ["approval.request"],
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "object",
          description: "Operation metadata including toolName, arguments, category, risk, and reason.",
        },
      },
      required: ["operation"],
    },
    execute: async (args, context) => {
      const operation = objectArg(args, "operation");
      const params: JsonObject = {
        run_id: context.runId,
        operation,
      };
      const classification = asObject(args.classification);
      if (classification) {
        params.classification = classification;
      }
      const fingerprint = asString(args.fingerprint);
      if (fingerprint) {
        params.fingerprint = fingerprint;
      }
      const sessionFingerprint = asString(args.sessionFingerprint);
      if (sessionFingerprint) {
        params.session_fingerprint = sessionFingerprint;
      }
      const summary = asString(args.summary);
      if (summary) {
        params.summary = summary;
      }
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "approval.request", params)) ?? {};
      const { content: rawContent, ...rawMetadata } = result;
      const metadata = {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        operation: asObject(rawMetadata.operation) ?? operation,
        ...rawMetadata,
      };
      return {
        content: asString(rawContent) ?? "Waiting for approval.",
        metadata,
      };
    },
  };
}

function createSearchMemoryNotesTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "search_memory_notes",
    description: "Search Memory Notes by query, type, status, and limit without mixing in Experience or Knowledge Base.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["memory.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional lexical query over Memory Notes." },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        status: { type: "string", enum: ["active", "superseded", "rejected"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    execute: async (args, context) => {
      const params: JsonObject = {};
      copyOptionalStringArg(args, params, "query");
      copyOptionalStringArg(args, params, "note_type");
      copyOptionalStringArg(args, params, "scope");
      copyOptionalStringArg(args, params, "status");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.search", params)) ?? {};
      const notes = Array.isArray(result.notes) ? result.notes : [];
      return {
        content: formatMemoryNotes(notes),
        metadata: { _memory_references: notes.map(formatMemoryReference).filter((reference): reference is JsonObject => reference !== null) },
      };
    },
  };
}

function createAddDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "add_document",
    description: "Add a document to the native Knowledge Base for future retrieval.",
    capabilities: ["knowledge.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        category: { type: "string" },
        file_type: { type: "string", enum: ["txt", "md"] },
        original_path: { type: "string" },
      },
      required: ["name", "content"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        name: stringArg(args, "name"),
        content: stringArg(args, "content"),
      };
      copyOptionalStringArg(args, params, "category");
      copyOptionalStringArg(args, params, "file_type");
      copyOptionalStringArg(args, params, "original_path");
      const tags = optionalStringListArg(args, "tags");
      if (tags.length > 0) {
        params.tags = tags;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.add_document", params)) ?? {};
      const document = asObject(result.document) ?? {};
      const name = asString(document.name) ?? stringArg(args, "name");
      const id = asString(document.id) ?? "unknown";
      return { content: `Successfully added document '${name}' to knowledge base (ID: ${id})\nDocument saved locally and indexed for sparse retrieval.` };
    },
  };
}

function createQueryKnowledgeTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "query_knowledge",
    description: "Query the native Knowledge Base for contextual evidence relevant to the current task.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural-language knowledge retrieval query." },
        category: { type: "string", description: "Optional knowledge document category filter." },
        tags: { type: "string", description: "Optional comma-separated tags filter." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        query: stringArg(args, "query"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "category");
      const tags = optionalStringListArg(args, "tags");
      if (tags.length > 0) {
        params.tags = tags;
      }
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.query", params)) ?? {};
      const rawResults = Array.isArray(result.results)
        ? result.results
        : Array.isArray(result.documents)
          ? result.documents
          : [];
      return { content: formatKnowledgeQueryResults(normalizeKnowledgeQueryResults(rawResults)) };
    },
  };
}

function createListDocumentsTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "list_documents",
    description: "List documents in the native Knowledge Base.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    execute: async (args, context) => {
      const params: JsonObject = {};
      copyOptionalStringArg(args, params, "category");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.list_documents", params)) ?? {};
      const documents = Array.isArray(result.documents) ? result.documents : [];
      return { content: formatKnowledgeDocuments(documents) };
    },
  };
}

function createGetDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "get_document",
    description: "Get the full content of a Knowledge Base document by ID.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        doc_id: { type: "string", minLength: 1 },
      },
      required: ["doc_id"],
    },
    execute: async (args, context) => {
      const docId = stringArg(args, "doc_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.get_document", { doc_id: docId })) ?? {};
      const content = typeof result.content === "string" ? result.content : "";
      return { content: `## Document Content (ID: ${docId})\n\n${content}` };
    },
  };
}

function createDeleteDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "delete_document",
    description: "Delete a document and its chunks from the native Knowledge Base.",
    capabilities: ["knowledge.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        doc_id: { type: "string", minLength: 1 },
      },
      required: ["doc_id"],
    },
    execute: async (args, context) => {
      const docId = stringArg(args, "doc_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.delete_document", { doc_id: docId })) ?? {};
      return {
        content: result.deleted === true
          ? `Successfully deleted document ${docId} and all associated data.`
          : `Error: Document ${docId} not found`,
      };
    },
  };
}

function createQueryRagTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "query_rag",
    description: "Compatibility alias for query_knowledge. Query the native retrieval index for workspace knowledge.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural-language retrieval query." },
        collection: { type: "string", description: "Optional native RAG collection or workspace area to query." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        query: stringArg(args, "query"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "collection");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "rag.query", params)) ?? {};
      const documents = Array.isArray(result.documents) ? result.documents : [];
      return { content: formatRagDocuments(documents) };
    },
  };
}

function createSaveMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "save_memory_note",
    description:
      "Save durable agent-side memory as a typed Memory Note. Use this only for durable preferences, instructions, project facts, decisions, fixes, or followups.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        priority: { type: "number", minimum: 0, maximum: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        metadata: { type: "string", description: "Optional JSON object metadata." },
        message_start: { type: "integer", minimum: 0 },
        message_end: { type: "integer", minimum: 0 },
      },
      required: ["content", "note_type"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        content: stringArg(args, "content"),
        note_type: stringArg(args, "note_type"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "scope");
      const priority = optionalNumberArg(args, "priority");
      if (priority !== undefined) {
        params.priority = priority;
      }
      const confidence = optionalNumberArg(args, "confidence");
      if (confidence !== undefined) {
        params.confidence = confidence;
      }
      const tags = optionalStringArg(args, "tags");
      if (tags !== undefined) {
        params.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
      const metadata = optionalStringArg(args, "metadata");
      if (metadata !== undefined) {
        const parsed = JSON.parse(metadata);
        if (!asObject(parsed)) {
          throw new Error("metadata must be a JSON object");
        }
        params.metadata = parsed;
      }
      const messageStart = optionalIntegerArg(args, "message_start");
      if (messageStart !== undefined) {
        params.message_start = messageStart;
      }
      const messageEnd = optionalIntegerArg(args, "message_end");
      if (messageEnd !== undefined) {
        params.message_end = messageEnd;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.save", params)) ?? {};
      const note = asObject(result.note) ?? {};
      return {
        content: `Memory Note saved: ${asString(note.id) ?? "unknown"} (${asString(note.type) ?? "unknown"}, ${asString(note.status) ?? "unknown"})`,
      };
    },
  };
}

function createTraceMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "trace_memory_note",
    description: "Trace a Memory Note to its canonical JSONL row and rendered memory view location.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["memory.read"],
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
      },
      required: ["note_id"],
    },
    execute: async (args, context) => {
      const noteId = stringArg(args, "note_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.trace", {
        note_id: noteId,
      })) ?? {};
      return { content: formatMemoryTrace(result) };
    },
  };
}

function createRejectMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "reject_memory_note",
    description: "Mark a Memory Note as rejected so it no longer appears in active memory recall or managed views.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      required: ["note_id"],
    },
    execute: async (args, context) => {
      const params: JsonObject = { note_id: stringArg(args, "note_id") };
      copyOptionalStringArg(args, params, "reason");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.reject", params)) ?? {};
      const note = asObject(result.note) ?? {};
      return { content: `Memory Note rejected: ${asString(note.id) ?? params.note_id}` };
    },
  };
}

function createSupersedeMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "supersede_memory_note",
    description: "Replace an existing Memory Note with a new active note and mark the old note as superseded.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
        replacement_content: { type: "string", minLength: 1 },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        priority: { type: "number", minimum: 0, maximum: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        metadata: { type: "string", description: "Optional JSON object metadata." },
        message_start: { type: "integer", minimum: 0 },
        message_end: { type: "integer", minimum: 0 },
      },
      required: ["note_id", "replacement_content"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        note_id: stringArg(args, "note_id"),
        replacement_content: stringArg(args, "replacement_content"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "note_type");
      copyOptionalStringArg(args, params, "scope");
      const priority = optionalNumberArg(args, "priority");
      if (priority !== undefined) {
        params.priority = priority;
      }
      const confidence = optionalNumberArg(args, "confidence");
      if (confidence !== undefined) {
        params.confidence = confidence;
      }
      const tags = optionalStringArg(args, "tags");
      if (tags !== undefined) {
        params.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
      const metadata = optionalStringArg(args, "metadata");
      if (metadata !== undefined) {
        const parsed = JSON.parse(metadata);
        if (!asObject(parsed)) {
          throw new Error("metadata must be a JSON object");
        }
        params.metadata = parsed;
      }
      const messageStart = optionalIntegerArg(args, "message_start");
      if (messageStart !== undefined) {
        params.message_start = messageStart;
      }
      const messageEnd = optionalIntegerArg(args, "message_end");
      if (messageEnd !== undefined) {
        params.message_end = messageEnd;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.supersede", params)) ?? {};
      const oldNote = asObject(result.old_note) ?? {};
      const replacement = asObject(result.note) ?? {};
      return {
        content: `Memory Note superseded: ${asString(oldNote.id) ?? params.note_id} -> ${asString(replacement.id) ?? "unknown"}`,
      };
    },
  };
}

function createCallMcpTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "call_mcp_tool",
    description: "Call an allowlisted tool on a configured native MCP server.",
    capabilities: ["mcp.call"],
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", minLength: 1, description: "Configured MCP server name." },
        tool: { type: "string", minLength: 1, description: "Raw MCP tool name on that server." },
        arguments: {
          type: "object",
          description: "JSON object arguments to pass to the MCP tool.",
        },
      },
      required: ["server", "tool"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        server: stringArg(args, "server"),
        tool: stringArg(args, "tool"),
        arguments: asObject(args.arguments) ?? {},
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "mcp.call_tool", params)) ?? {};
      return { content: formatMcpToolResult(result) };
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

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a string when provided`);
  }
  return value;
}

function stringArgAllowEmpty(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function objectArg(args: Record<string, unknown>, key: string): JsonObject {
  const value = args[key];
  const object = asObject(value);
  if (!object) {
    throw new Error(`${key} must be an object`);
  }
  return object;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number when provided`);
  }
  return value;
}

function optionalIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = optionalNumberArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when provided`);
  }
  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided`);
  }
  return value;
}

function copyOptionalStringArg(args: Record<string, unknown>, params: JsonObject, key: string): void {
  const value = optionalStringArg(args, key);
  if (value !== undefined) {
    params[key] = value;
  }
}

function requireTraceId(traceId: string | undefined): string {
  if (!traceId) {
    throw new Error("native tool requires traceId");
  }
  return traceId;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  path: string,
): { ok: true; content: string } | { ok: false; content: string } {
  const usesCrLf = content.includes("\r\n");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedOld = oldText.replace(/\r\n/g, "\n");
  const normalizedNew = newText.replace(/\r\n/g, "\n");
  const match = findTextMatch(normalizedContent, normalizedOld);
  if (!match.fragment) {
    return { ok: false, content: `Error: old_text not found in ${path}. Verify the file content.` };
  }
  if (match.count > 1 && !replaceAll) {
    return {
      ok: false,
      content: `Warning: old_text appears ${match.count} times. Provide more context to make it unique, or set replace_all=true.`,
    };
  }
  const updated = replaceAll
    ? normalizedContent.split(match.fragment).join(normalizedNew)
    : normalizedContent.replace(match.fragment, normalizedNew);
  return { ok: true, content: usesCrLf ? updated.replace(/\n/g, "\r\n") : updated };
}

function findTextMatch(content: string, oldText: string): { fragment: string | null; count: number } {
  if (oldText.length > 0 && content.includes(oldText)) {
    return { fragment: oldText, count: content.split(oldText).length - 1 };
  }
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) {
    return { fragment: null, count: 0 };
  }
  const strippedOld = oldLines.map((line) => line.trim());
  const contentLines = content.split("\n");
  const candidates: string[] = [];
  for (let index = 0; index <= contentLines.length - strippedOld.length; index += 1) {
    const window = contentLines.slice(index, index + strippedOld.length);
    if (window.map((line) => line.trim()).join("\n") === strippedOld.join("\n")) {
      candidates.push(window.join("\n"));
    }
  }
  return { fragment: candidates[0] ?? null, count: candidates.length };
}

function formatShellResult(result: JsonObject): string {
  const parts: string[] = [];
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    parts.push(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr.trim().length > 0) {
    parts.push(`STDERR:\n${result.stderr}`);
  }
  if (typeof result.exit_code === "number") {
    parts.push(`Exit code: ${result.exit_code}`);
  }
  return parts.join("\n").trim() || "(no output)";
}

function formatMemoryNotes(notes: unknown[]): string {
  const formatted = notes.map(formatMemoryNote).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "No Memory Notes found.";
  }
  return `## Memory Notes\n${formatted.join("\n")}`;
}

function formatMemoryNote(value: unknown): string | null {
  const note = asObject(value);
  if (!note) {
    return null;
  }
  const id = asString(note.id) ?? "unknown";
  const scope = asString(note.scope) ?? "project";
  const type = asString(note.type) ?? "project";
  const status = asString(note.status) ?? "active";
  const priority = typeof note.priority === "number" ? note.priority : 0.5;
  const confidence = typeof note.confidence === "number" ? note.confidence : 0.5;
  const tags = Array.isArray(note.tags) && note.tags.length > 0 ? ` tags=${note.tags.join(",")}` : "";
  const metadata = asObject(note.metadata) ? ` metadata=${JSON.stringify(note.metadata)}` : "";
  return `- [${id}] ${scope}/${type}/${status} priority=${formatMemoryNumber(priority)} confidence=${formatMemoryNumber(confidence)}${tags}${metadata}\n  ${asString(note.content) ?? ""}\n  sources: ${formatMemorySources(note.sources)}`;
}

function optionalStringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`${key} must contain non-empty strings`);
      }
      return item.trim();
    });
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a string or string array when provided`);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatMemoryTrace(result: JsonObject): string {
  const note = asObject(result.note) ?? {};
  const locations = asObject(result.locations) ?? {};
  const noteId = asString(note.id) ?? "unknown";
  const status = asString(note.status) ?? "unknown";
  const noteType = asString(note.type) ?? "unknown";
  const scope = asString(note.scope) ?? "unknown";
  const file = asString(locations.file);
  const line = typeof locations.line === "number" ? locations.line : undefined;
  const viewFile = asString(locations.view_file);
  const viewLine = typeof locations.view_line === "number" ? locations.view_line : undefined;
  const location = file ? `${file}${line !== undefined ? `:${line}` : ""}` : "unknown";
  const viewLocation = viewFile ? `${viewFile}${viewLine !== undefined ? `:${viewLine}` : ""}` : "unknown";
  return [
    `Memory Note ${noteId} (${scope}/${noteType}/${status})`,
    asString(note.content) ?? "",
    `canonical: ${location}`,
    `view: ${viewLocation}`,
  ].filter((lineContent) => lineContent.length > 0).join("\n");
}

function formatMemoryNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function formatMemorySources(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "none";
  }
  return value.map(formatMemorySource).filter((line): line is string => line !== null).join("; ") || "none";
}

function formatMemorySource(value: unknown): string | null {
  const source = asObject(value);
  if (!source) {
    return null;
  }
  const fields = [asString(source.capture_origin) ?? "explicit"];
  const sessionKey = asString(source.session_key);
  if (sessionKey) {
    fields.push(`session=${sessionKey}`);
  }
  const sourceFile = asString(source.source_file);
  if (sourceFile) {
    fields.push(`file=${sourceFile}`);
  }
  const messageStart = typeof source.message_start === "number" ? source.message_start : null;
  const messageEnd = typeof source.message_end === "number" ? source.message_end : null;
  if (messageStart !== null || messageEnd !== null) {
    fields.push(`messages=${messageStart ?? ""}-${messageEnd ?? ""}`);
  }
  return fields.join(" ");
}

function formatMemoryReference(value: unknown): JsonObject | null {
  const note = asObject(value);
  if (!note) {
    return null;
  }
  return {
    note_id: asString(note.id) ?? "unknown",
    scope: asString(note.scope) ?? "project",
    type: asString(note.type) ?? "project",
    status: asString(note.status) ?? "active",
    content: asString(note.content) ?? "",
    priority: typeof note.priority === "number" ? note.priority : 0.5,
    confidence: typeof note.confidence === "number" ? note.confidence : 0.5,
    tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === "string") : [],
    metadata: asObject(note.metadata) ?? {},
    evidence_ids: memoryEvidenceIds(note.sources),
    file: asString(note.file),
    line: typeof note.line === "number" ? note.line : undefined,
    view_file: asString(note.view_file),
    view_line: typeof note.view_line === "number" ? note.view_line : undefined,
  };
}

function memoryEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  for (const source of value) {
    const object = asObject(source);
    const evidenceIds = Array.isArray(object?.evidence_ids) ? object.evidence_ids : [];
    for (const evidenceId of evidenceIds) {
      if (typeof evidenceId === "string") {
        ids.add(evidenceId);
      }
    }
  }
  return Array.from(ids).sort();
}

function formatRagDocuments(documents: unknown[]): string {
  const formatted = documents.map(formatRagDocument).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "No RAG results found.";
  }
  return `## RAG Results\n${formatted.join("\n")}`;
}

function formatKnowledgeDocuments(documents: unknown[]): string {
  const formatted = documents.map(formatKnowledgeDocument).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "Knowledge base is empty. Use add_document to add documents.";
  }
  return `## Knowledge Base Documents\n${formatted.join("\n")}`;
}

function formatKnowledgeDocument(value: unknown): string | null {
  const document = asObject(value);
  if (!document) {
    return null;
  }
  const name = asString(document.name) ?? "Unknown";
  const id = asString(document.id) ?? "unknown";
  const tags = Array.isArray(document.tags)
    ? document.tags.filter((tag): tag is string => typeof tag === "string").join(", ") || "none"
    : "none";
  const file = asString(document.file_path) ?? "";
  const fileType = asString(document.file_type) ?? "txt";
  const category = asString(document.category) ?? "uncategorized";
  const chunks = typeof document.chunk_count === "number" ? document.chunk_count : 0;
  const content = asString(document.content) ?? "";
  const created = asString(document.created_at) ?? "";
  return [
    `- **${name}** (ID: ${id})`,
    `  - File: ${file}`,
    `  - Type: ${fileType}`,
    `  - Category: ${category || "uncategorized"}`,
    `  - Tags: ${tags}`,
    `  - Chunks: ${chunks}`,
    `  - Length: ${content.length} chars`,
    `  - Created: ${created}`,
  ].join("\n");
}

function formatRagDocument(value: unknown): string | null {
  const document = asObject(value);
  if (!document) {
    return null;
  }
  const id = asString(document.id) ?? asString(document.path) ?? "unknown";
  const title = asString(document.title) ?? asString(document.path) ?? id;
  const path = asString(document.path);
  const score = typeof document.score === "number" ? ` score=${formatMemoryNumber(document.score)}` : "";
  const excerpt = asString(document.excerpt) ?? asString(document.content) ?? "";
  return `- [${id}] ${title}${path ? ` (${path})` : ""}${score}\n  ${excerpt}`;
}

function formatMcpToolResult(result: JsonObject): string {
  const content = result.content;
  if (typeof content === "string") {
    return content || "(no output)";
  }
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const object = asObject(item);
      return asString(object?.text) ?? asString(object?.content) ?? JSON.stringify(item);
    });
    return parts.filter((part) => part.length > 0).join("\n") || "(no output)";
  }
  if (result.result !== undefined) {
    return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  }
  return "(no output)";
}
