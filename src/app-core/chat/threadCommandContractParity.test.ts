import { describe, expect, it } from "vitest";

import { THREAD_CAPABILITY_IDS } from "./threadCapabilities";
import { THREAD_COMMAND_KINDS } from "./threadCommand";

describe("desktop command contract parity", () => {
  it("records backend-authored effective capability decisions", () => {
    expect(THREAD_CAPABILITY_IDS).toEqual([
      "agent.cancel",
      "agent.retry",
    ]);
  });

  it("records typed runtime-affecting command kinds", () => {
    expect(THREAD_COMMAND_KINDS).toEqual([
      "agent.cancel",
      "form.submit",
      "form.cancel",
      "operation.retry",
    ]);
  });
});
