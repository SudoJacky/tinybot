import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDesktopCoworkActionRequest } from "./desktopCowork";

describe("desktop Cowork root WebUI parity", () => {
  const legacyWebuiSource = readFileSync(resolve(process.cwd(), "webui", "assets", "src", "legacy", "app.js"), "utf8");

  function rootCoworkDefault(name: "ROUNDS" | "AGENTS" | "AGENT_CALLS"): number {
    const pattern = new RegExp(`const COWORK_DEFAULT_RUN_${name} = (\\d+);`);
    const match = legacyWebuiSource.match(pattern);
    expect(match, `root WebUI COWORK_DEFAULT_RUN_${name} constant`).not.toBeNull();
    return Number(match?.[1]);
  }

  test("keeps run payload defaults aligned with the root WebUI Cowork flow", () => {
    expect(legacyWebuiSource).toContain("run_until_idle: true");
    expect(legacyWebuiSource).toContain("stop_on_blocker: false");

    expect(buildDesktopCoworkActionRequest({ action: "runSession", sessionId: "cowork-1" })).toMatchObject({
      method: "POST",
      path: "/api/cowork/sessions/cowork-1/run",
      body: {
        max_rounds: rootCoworkDefault("ROUNDS"),
        max_agents: rootCoworkDefault("AGENTS"),
        max_agent_calls: rootCoworkDefault("AGENT_CALLS"),
        run_until_idle: true,
        stop_on_blocker: false,
      },
    });
  });
});
