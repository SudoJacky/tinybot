import { describe, expect, it } from "vitest";

import { TINYOS_CAPABILITY_IDS } from "./tinyOsCapabilities";
import { TINYOS_COMMAND_KINDS } from "./tinyOsCommandGateway";
import { TINYOS_PRE_KERNEL_APP_IDS } from "./tinyOsDesktopModel";

describe("TinyOS pre-kernel contract parity", () => {
  it("records the supported application surface", () => {
    expect(TINYOS_PRE_KERNEL_APP_IDS).toEqual([
      "files",
      "terminal",
      "browser",
      "plan",
      "memory",
      "subagents",
      "artifacts",
      "inspector",
    ]);
  });

  it("records backend-authored effective capability decisions", () => {
    expect(TINYOS_CAPABILITY_IDS).toEqual([
      "agent.pause",
      "agent.resume",
      "agent.cancel",
      "agent.retry",
      "files.read",
      "files.requestChange",
      "files.directEdit",
      "files.save",
      "terminal.inspect",
      "terminal.execute",
      "terminal.cancel",
      "browser.structured",
      "browser.realCapture",
      "browser.interact",
    ]);
  });

  it("records typed runtime-affecting command kinds", () => {
    expect(TINYOS_COMMAND_KINDS).toEqual([
      "agent.cancel",
      "agent.pause",
      "agent.resume",
      "approval.resolve",
      "form.submit",
      "form.cancel",
      "operation.retry",
      "agent.request_change",
      "file.save",
      "file.move",
      "file.delete",
      "terminal.execute",
      "terminal.cancel",
      "browser.interact",
    ]);
  });
});
