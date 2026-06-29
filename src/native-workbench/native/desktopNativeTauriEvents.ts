export function toDesktopNativeTauriEventName(eventName: string): string {
  return eventName.replace(/\./g, ":");
}
