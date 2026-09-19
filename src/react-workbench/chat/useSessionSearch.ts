import { useEffect, useState } from "react";
import type { SessionSearchResults, SessionStore } from "../services";

export function useSessionSearch(query: string, search: SessionStore["search"]) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ query: string; results?: SessionSearchResults; error?: string }>({ query: "" });
  useEffect(() => {
    if (!query || !search) return;
    let active = true;
    setState({ query });
    const timer = setTimeout(() => {
      void search(query).then((results) => {
        if (active) setState({ query, results });
      }).catch((cause: unknown) => {
        if (!active) return;
        console.error("[chat-search] search failed", cause);
        setState({ query, error: cause instanceof Error ? cause.message : String(cause) });
      });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [query, search, retry]);
  const current = query && search && state.query === query ? state : undefined;
  return {
    results: current?.results,
    error: current?.error,
    pending: Boolean(query && search && !current?.results && !current?.error),
    retry: () => setRetry((value) => value + 1),
  };
}
