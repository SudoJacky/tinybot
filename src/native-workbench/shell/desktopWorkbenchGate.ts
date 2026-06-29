export type DesktopWebUiMode = "root-webui" | "native-workbench";

export interface DesktopWorkbenchModeResolution {
  mode: DesktopWebUiMode;
  requestedMode: DesktopWebUiMode;
  source: "default" | "query" | "storage";
  fallbackReason?: string;
}

interface ResolveDesktopWorkbenchModeOptions {
  location?: Pick<Location, "search">;
  storage?: Pick<Storage, "getItem">;
  nativeWorkbenchAvailable?: boolean;
  defaultMode?: DesktopWebUiMode;
}

export const DESKTOP_WORKBENCH_QUERY_PARAM = "desktop-workbench";
export const DESKTOP_WORKBENCH_STORAGE_KEY = "tinybot.desktop.workbench";

export function resolveDesktopWorkbenchStartupMode(
  options: Omit<ResolveDesktopWorkbenchModeOptions, "defaultMode" | "nativeWorkbenchAvailable"> = {},
): DesktopWorkbenchModeResolution {
  return resolveDesktopWorkbenchMode({
    ...options,
    nativeWorkbenchAvailable: true,
    defaultMode: "native-workbench",
  });
}

export function resolveDesktopWorkbenchMode({
  location = window.location,
  storage = window.localStorage,
  nativeWorkbenchAvailable = false,
  defaultMode = "root-webui",
}: ResolveDesktopWorkbenchModeOptions = {}): DesktopWorkbenchModeResolution {
  const queryMode = modeFromQuery(location.search);
  const storageMode = queryMode ? null : modeFromStorage(storage);
  const requestedMode = queryMode?.mode ?? storageMode?.mode ?? defaultMode;
  const source = queryMode?.source ?? storageMode?.source ?? "default";

  if (requestedMode === "native-workbench" && !nativeWorkbenchAvailable) {
    return {
      mode: "root-webui",
      requestedMode,
      source,
      fallbackReason: "native workbench entrypoint is not available in this migration slice",
    };
  }

  return { mode: requestedMode, requestedMode, source };
}

function modeFromQuery(search: string): Pick<DesktopWorkbenchModeResolution, "mode" | "source"> | null {
  const params = new URLSearchParams(search);
  const value = params.get(DESKTOP_WORKBENCH_QUERY_PARAM);
  const mode = modeFromValue(value);
  return mode ? { mode, source: "query" } : null;
}

function modeFromStorage(
  storage: Pick<Storage, "getItem"> | null,
): Pick<DesktopWorkbenchModeResolution, "mode" | "source"> | null {
  if (!storage) {
    return null;
  }

  try {
    const mode = modeFromValue(storage.getItem(DESKTOP_WORKBENCH_STORAGE_KEY));
    return mode ? { mode, source: "storage" } : null;
  } catch {
    return null;
  }
}

function modeFromValue(value: string | null): DesktopWebUiMode | null {
  switch (value?.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "native":
    case "native-workbench":
    case "workbench":
      return "native-workbench";
    case "0":
    case "false":
    case "off":
    case "root":
    case "root-webui":
    case "webui":
      return "root-webui";
    default:
      return null;
  }
}
