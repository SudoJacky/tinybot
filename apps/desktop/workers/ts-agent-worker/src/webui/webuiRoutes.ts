import { isJsonObject, type JsonObject } from "../protocol/messages.ts";

export type WebuiRouteSpec = {
  key: string;
  method: string;
  path: string;
  public: boolean;
};

export type WebuiRouteRequest = {
  method: string;
  path: string;
  body?: unknown;
};

export type WebuiRouteResponse = {
  status: number;
  body: unknown;
};

export type WebuiStatusSnapshot = {
  channelRunning: boolean;
  provider: Record<string, unknown> | null;
  model: string | null;
};

export type WebuiStatusProvider =
  | WebuiStatusSnapshot
  | (() => Promise<WebuiStatusSnapshot> | WebuiStatusSnapshot);

const WEBUI_ROUTE_SPECS: WebuiRouteSpec[] = [
  { key: "get_status", method: "GET", path: "/api/status", public: false },
];

export function webuiRouteSpecs(): WebuiRouteSpec[] {
  return WEBUI_ROUTE_SPECS.map((spec) => ({ ...spec }));
}

export async function handleWebuiRouteRequest(
  request: WebuiRouteRequest,
  statusProvider: WebuiStatusProvider | undefined,
): Promise<WebuiRouteResponse> {
  const method = request.method.toUpperCase();
  const path = new URL(request.path, "http://worker.local").pathname;
  if (method === "GET" && path === "/api/status") {
    return { status: 200, body: webuiStatusBody(await resolveStatus(statusProvider)) };
  }
  return {
    status: 404,
    body: {
      error: "webui control route unavailable",
      route: routeKey(method, path),
    },
  };
}

export function parseWebuiRouteRequest(params: JsonObject | undefined): WebuiRouteRequest {
  if (!isJsonObject(params)) {
    throw new Error("webui.handle_request requires object params");
  }
  const method = stringParam(params.method)?.toUpperCase();
  const path = stringParam(params.path);
  if (!method || !path) {
    throw new Error("webui.handle_request requires params.method and params.path");
  }
  return params.body === undefined ? { method, path } : { method, path, body: params.body };
}

async function resolveStatus(provider: WebuiStatusProvider | undefined): Promise<WebuiStatusSnapshot> {
  if (!provider) {
    return { channelRunning: true, provider: null, model: null };
  }
  return typeof provider === "function" ? provider() : provider;
}

function webuiStatusBody(status: WebuiStatusSnapshot): Record<string, unknown> {
  return {
    channels: { websocket: { enabled: true, running: status.channelRunning } },
    provider: status.provider,
    model: status.model,
  };
}

function routeKey(method: string, path: string): string {
  const spec = WEBUI_ROUTE_SPECS.find((entry) => entry.method === method && entry.path === path);
  return spec?.key ?? `${method} ${path}`;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
