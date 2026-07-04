import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  KnowledgeDocumentsOptions,
  KnowledgeGraphOptions,
  NativeKnowledgeApi,
} from "../gateway/gatewayHttpClient";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createDesktopNativeKnowledgeApi(options: { invoke?: TauriInvoke } = {}): NativeKnowledgeApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    documents: (documentOptions: KnowledgeDocumentsOptions = {}) =>
      invoke("worker_knowledge_documents", { input: documentOptions }),
    addDocument: (body: unknown) => invoke("worker_knowledge_add_document", { input: { body } }),
    document: (documentId: string) =>
      invoke("worker_knowledge_document", { input: { docId: documentId } }),
    deleteDocument: (documentId: string) =>
      invoke("worker_knowledge_delete_document", { input: { docId: documentId } }),
    job: (jobId: string) => invoke("worker_knowledge_job", { input: { jobId } }),
    rebuildIndex: (type: string = "all") =>
      invoke("worker_knowledge_rebuild_index", { input: { rebuildType: type } }),
    stats: () => invoke("worker_knowledge_stats"),
    graph: (graphOptions: KnowledgeGraphOptions = {}) =>
      invoke("worker_knowledge_graph", { input: graphOptions }),
  };
}
