import { describe, expect, it } from "vitest";

import { TINYOS_CAPABILITY_IDS } from "./tinyOsCapabilities";
import { TINYOS_COMMAND_KINDS } from "./tinyOsCommand";

describe("desktop command contract parity", () => {
  it("records backend-authored effective capability decisions", () => {
    expect(TINYOS_CAPABILITY_IDS).toEqual([
      "agent.cancel",
      "agent.retry",
    ]);
  });

  it("records typed runtime-affecting command kinds", () => {
    expect(TINYOS_COMMAND_KINDS).toEqual([
      "agent.cancel",
      "form.submit",
      "form.cancel",
      "operation.retry",
    ]);
  });
});
