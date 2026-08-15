import { useEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";

type DeferredSurfaceModule<Props extends object> = {
  default: ComponentType<Props>;
};

type DeferredSurfaceState<Props extends object> =
  | { status: "loading" }
  | { status: "ready"; Surface: ComponentType<Props> }
  | { status: "failed"; error: Error };

export function DeferredSurface<Props extends object>({
  load,
  name,
  surfaceProps,
}: {
  load: () => Promise<DeferredSurfaceModule<Props>>;
  name: string;
  surfaceProps: Props;
}) {
  const { t } = useTranslation("common");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DeferredSurfaceState<Props>>({ status: "loading" });
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void load()
      .then((module) => {
        if (!cancelled) {
          setState({ status: "ready", Surface: module.default });
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        console.error("[tinybot-deferred-surface]", { attempt: attempt + 1, error, name: nameRef.current });
        setState({ status: "failed", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, load]);

  if (state.status === "loading") {
    return <p aria-live="polite" className="react-empty-state" role="status">{t("deferredSurface.loading", { name })}</p>;
  }
  if (state.status === "failed") {
    return (
      <div className="react-empty-state" role="alert">
        <p>{t("deferredSurface.loadFailed", { message: state.error.message, name })}</p>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {t("deferredSurface.retry", { name })}
        </button>
      </div>
    );
  }
  const Surface = state.Surface;
  return <Surface {...surfaceProps} />;
}
