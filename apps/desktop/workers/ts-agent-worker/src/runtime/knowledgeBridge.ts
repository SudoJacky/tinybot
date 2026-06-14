import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { WebuiKnowledgeListRequest, WebuiKnowledgeProvider } from "../webui/webuiRoutes.ts";

export class NativeKnowledgeBridge implements WebuiKnowledgeProvider {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  listDocuments(request: WebuiKnowledgeListRequest, traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.list_documents", request);
  }

  addDocument(body: Record<string, unknown>, traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.add_document", body);
  }

  getDocument(docId: string, traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.get_document", { doc_id: docId });
  }

  deleteDocument(docId: string, traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.delete_document", { doc_id: docId });
  }

  query(body: Record<string, unknown>, traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.query", {
      ...body,
      limit: numberValue(body.top_k) ?? numberValue(body.topK) ?? numberValue(body.limit),
    });
  }

  stats(traceId: string): Promise<unknown> {
    return this.rpcClient.request(traceId, "knowledge.stats", {});
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
