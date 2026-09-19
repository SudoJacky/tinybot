/** Local recovery is independent of route lifetime; saved backend revisions remain authoritative. */
export function readEditorDraft<T>(key: string): T | null {
  const value = localStorage.getItem(key);
  return value === null ? null : JSON.parse(value) as T;
}
export function writeEditorDraft(key: string, value: unknown | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}
