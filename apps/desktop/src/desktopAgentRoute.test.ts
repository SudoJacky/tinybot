import { describe, expect, test } from "vitest";

import { resolveDesktopAgentRoute } from "./desktopAgentRoute";

describe("desktop agent route resolver", () => {
  test("keeps the gateway route by default", () => {
    expect(resolveDesktopAgentRoute({ search: "", storedRoute: null })).toBe("gateway");
    expect(resolveDesktopAgentRoute({ search: "?agentRoute=python", storedRoute: "worker" })).toBe("gateway");
  });

  test("enables the TS agent route from URL or local storage", () => {
    expect(resolveDesktopAgentRoute({ search: "?agentRoute=ts-agent", storedRoute: null })).toBe("ts-agent");
    expect(resolveDesktopAgentRoute({ search: "?desktopAgentRoute=ts-agent", storedRoute: null })).toBe("ts-agent");
    expect(resolveDesktopAgentRoute({ search: "", storedRoute: "ts-agent" })).toBe("ts-agent");
  });
});
