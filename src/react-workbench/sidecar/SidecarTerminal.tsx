import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  NativeTerminalRuntimeApi,
  NativeTerminalSnapshot,
} from "../../app-core/native/desktopNativeTerminal";
import type { SidecarTerminalTab } from "./sidecarModel";
import "./SidecarTerminal.css";

export type SidecarTerminalProps = {
  externalError?: string;
  terminalRuntime?: NativeTerminalRuntimeApi;
  tab: SidecarTerminalTab;
  workspaceLabel: string;
};

type TerminalProcessState = {
  exitCode?: number;
  running: boolean;
};

export function SidecarTerminal({
  externalError,
  tab,
  terminalRuntime,
  workspaceLabel,
}: SidecarTerminalProps) {
  const { t } = useTranslation("chat");
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [process, setProcess] = useState<TerminalProcessState>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminalRuntime) return;
    const runtime: NativeTerminalRuntimeApi = terminalRuntime;

    let disposed = false;
    let connected = false;
    let cursor = 0;
    let operation: Promise<void> = Promise.resolve();
    let resizeFrame = 0;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5_000,
      theme: {
        background: "#1f1e1b",
        cursor: "#f3eee5",
        foreground: "#f3eee5",
        selectionBackground: "#766d5f80",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
      const next = operation.then(task, task);
      operation = next.then(() => undefined, () => undefined);
      return next;
    }

    function acceptSnapshot(snapshot: NativeTerminalSnapshot) {
      if (disposed) return;
      if (snapshot.output) terminal.write(snapshot.output);
      cursor = Math.max(cursor, snapshot.cursor);
      setProcess({
        ...(snapshot.exitCode == null ? {} : { exitCode: snapshot.exitCode }),
        running: snapshot.running,
      });
      if (snapshot.failure) setError(snapshot.failure);
    }

    function fit(resizeNative: boolean) {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      if (resizeNative && connected) {
        void enqueue(() => runtime.resize({
          cols: terminal.cols,
          rows: terminal.rows,
          terminalId: tab.id,
        })).catch((reason) => {
          if (!disposed) setError(errorMessage(reason));
        });
      }
    }

    fit(false);
    const dataSubscription = terminal.onData((input) => {
      if (!connected || disposed) return;
      void enqueue(() => runtime.write({
        cursor,
        input,
        terminalId: tab.id,
      })).then(acceptSnapshot).catch((reason) => {
        if (!disposed) setError(errorMessage(reason));
      });
    });
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => fit(true));
    });
    resizeObserver?.observe(host);

    void (async () => {
      try {
        let snapshot = await enqueue(() => runtime.create({
          cols: terminal.cols,
          rows: terminal.rows,
          shell: tab.shell,
          terminalId: tab.id,
          workingDirectory: tab.workspaceId,
        }));
        if (disposed) return;
        connected = true;
        acceptSnapshot(snapshot);
        fit(true);
        while (!disposed && snapshot.running) {
          snapshot = await enqueue(() => runtime.poll({
            cursor,
            terminalId: tab.id,
            yieldTimeMs: 250,
          }));
          acceptSnapshot(snapshot);
        }
      } catch (reason) {
        if (!disposed) setError(errorMessage(reason));
      }
    })();

    return () => {
      disposed = true;
      connected = false;
      window.cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
    };
  }, [tab.id, tab.shell, tab.workspaceId, terminalRuntime]);

  const runtimeError = externalError || error;
  const shellLabel = tab.shell === "cmd" ? t("sidecar.commandPrompt") : t("sidecar.powerShell");
  const processLabel = !process
    ? t("sidecar.terminalStarting")
    : process.running
      ? t("sidecar.terminalRunning")
      : process.exitCode === undefined
        ? t("sidecar.terminalStopped")
        : t("sidecar.terminalExited", { code: process.exitCode });
  return (
    <section className="react-sidecar-terminal">
      <div className="react-sidecar-terminal__toolbar">
        <strong>{workspaceLabel || t("sidecar.workspace")}</strong>
        <span>{shellLabel}</span>
      </div>
      <div className="react-sidecar-terminal__viewport">
        {terminalRuntime ? (
          <div
            aria-label={t("sidecar.terminalViewport", { shell: shellLabel })}
            className="react-sidecar-terminal__surface"
            ref={hostRef}
            role="application"
          />
        ) : (
          <div className="react-sidecar-terminal__unavailable" role="status">
            <SquareTerminal aria-hidden="true" size={24} />
            <h2>{t("sidecar.terminalUnavailableTitle")}</h2>
            <p>{t("sidecar.terminalUnavailableDescription")}</p>
          </div>
        )}
        {runtimeError ? <p className="react-sidecar-terminal__error" role="alert">{runtimeError}</p> : null}
      </div>
      <footer>
        <span>{t("sidecar.terminalStatus")}</span>
        <span>{processLabel}</span>
      </footer>
    </section>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
