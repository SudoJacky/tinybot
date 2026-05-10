export function on(target, type, handler, options) {
  target?.addEventListener?.(type, handler, options);
  return () => target?.removeEventListener?.(type, handler, options);
}
