export type ProviderRetryMode = "standard" | "persistent";

export type ProviderRetryOptions = {
  retryMode?: ProviderRetryMode;
  sleep?: (seconds: number) => Promise<void>;
  onRetryWait?: (event: { attempt: number; delaySeconds: number; message: string }) => void;
};

const STANDARD_DELAYS = [1, 2, 4];
const PERSISTENT_MAX_ATTEMPTS = 8;

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  options: ProviderRetryOptions = {},
): Promise<T> {
  const retryMode = options.retryMode ?? "standard";
  const delays = retryMode === "persistent" ? persistentDelays() : STANDARD_DELAYS;
  let attempt = 0;
  let lastTransientMessage = "";
  let repeatedTransientCount = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isTransientProviderError(error)) {
        throw error;
      }
      const message = errorMessage(error);
      repeatedTransientCount = message === lastTransientMessage ? repeatedTransientCount + 1 : 1;
      lastTransientMessage = message;
      if (retryMode === "persistent" && repeatedTransientCount > PERSISTENT_MAX_ATTEMPTS) {
        throw error;
      }
      const fallbackDelay = delays[Math.min(attempt - 1, delays.length - 1)];
      if (fallbackDelay === undefined) {
        throw error;
      }
      const delaySeconds = extractRetryAfterSeconds(error) ?? fallbackDelay;
      options.onRetryWait?.({ attempt, delaySeconds, message });
      await (options.sleep ?? defaultSleep)(delaySeconds);
    }
  }
}

export function extractRetryAfterSeconds(error: unknown): number | undefined {
  const headerValue =
    header(error, "retry-after") ??
    header(asObject(error)?.response, "retry-after");
  const parsedHeader = parseRetryAfterHeaderSeconds(headerValue);
  if (parsedHeader !== undefined) {
    return parsedHeader;
  }
  const body = bodyText(error).toLowerCase();
  const bodyPatterns: Array<{ pattern: RegExp; defaultUnit?: string }> = [
    { pattern: /retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/ },
    { pattern: /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)/ },
    { pattern: /wait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)\s*before retry/ },
    { pattern: /retry[_-]?after["'\s:=]+(\d+(?:\.\d+)?)/, defaultUnit: "s" },
  ];
  for (const entry of bodyPatterns) {
    const match = body.match(entry.pattern);
    const parsed = retrySecondsFromMatch(match, entry.defaultUnit);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function isTransientProviderError(error: unknown): boolean {
  const status = numericValue(asObject(error)?.status ?? asObject(error)?.statusCode ?? asObject(asObject(error)?.response)?.status);
  if (status && [408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const text = `${errorMessage(error)} ${bodyText(error)}`.toLowerCase();
  return [
    "rate limit",
    "overloaded",
    "timeout",
    "timed out",
    "connection",
    "temporarily unavailable",
    "try again",
    "retry after",
  ].some((marker) => text.includes(marker));
}

function persistentDelays(): number[] {
  return [1, 2, 4, 8, 15, 30, 60, 60];
}

function defaultSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

function header(value: unknown, name: string): string | undefined {
  const object = asObject(value);
  const headers = asObject(object?.headers);
  const direct = headers?.[name] ?? headers?.[name.toLowerCase()] ?? headers?.[name.toUpperCase()];
  if (direct !== undefined) {
    return String(direct);
  }
  const get = asObject(object?.headers)?.get;
  if (typeof get === "function") {
    const got = get.call(object?.headers, name);
    return got === null || got === undefined ? undefined : String(got);
  }
  return undefined;
}

function bodyText(error: unknown): string {
  const object = asObject(error);
  const body = object?.doc ?? object?.body ?? asObject(object?.response)?.text ?? asObject(object?.response)?.body;
  return body === undefined || body === null ? "" : String(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : undefined;
}

function parseRetryAfterHeaderSeconds(value: unknown): number | undefined {
  const numeric = parsePositiveSeconds(value);
  if (numeric !== undefined) {
    return numeric;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  const timestampMs = Date.parse(String(value).trim());
  if (!Number.isFinite(timestampMs)) {
    return undefined;
  }
  return Math.max(1, Math.ceil((timestampMs - Date.now()) / 1000));
}

function retrySecondsFromMatch(match: RegExpMatchArray | null, defaultUnit?: string): number | undefined {
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? defaultUnit ?? "s").toLowerCase();
  if (unit === "ms" || unit === "milliseconds") {
    return Math.ceil(Math.max(0.1, value / 1000));
  }
  if (unit === "m" || unit === "min" || unit === "minutes") {
    return Math.ceil(Math.max(0.1, value * 60));
  }
  return Math.ceil(Math.max(0.1, value));
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
