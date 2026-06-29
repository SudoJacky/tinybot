export type GatewayConfig = {
  httpBaseUrl: string;
  wsUrl: string;
  requestTimeoutMs: number;
};

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  httpBaseUrl: "http://127.0.0.1:18790",
  wsUrl: "ws://127.0.0.1:18790/ws",
  requestTimeoutMs: 1200,
};

export function resolveGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const httpBaseUrl = stripTrailingSlash(overrides.httpBaseUrl ?? DEFAULT_GATEWAY_CONFIG.httpBaseUrl);
  return {
    httpBaseUrl,
    wsUrl: overrides.wsUrl ?? `${httpBaseUrl.replace(/^http/, "ws")}/ws`,
    requestTimeoutMs: overrides.requestTimeoutMs ?? DEFAULT_GATEWAY_CONFIG.requestTimeoutMs,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
