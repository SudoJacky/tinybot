import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const tauriRoot = resolve(__dirname, "../../../src-tauri");

function read(relativePath: string): string {
  return readFileSync(resolve(tauriRoot, relativePath), "utf8");
}

function registeredCommandNames(): string[] {
  const source = read("src/desktop/bootstrap.rs");
  const block = source.match(/generate_handler!\[([\s\S]*?)\]\)/)?.[1];
  if (!block) throw new Error("Unable to find the Tauri invoke handler command list.");

  return block
    .split(",")
    .map((entry) => {
      const segments = entry.trim().split("::");
      return segments[segments.length - 1];
    })
    .filter((entry): entry is string => Boolean(entry));
}

function manifestCommandNames(): string[] {
  return [...read("app_commands.rs").matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function permissionCommands(identifier: string): string[] {
  const source = read("permissions/app-commands.toml");
  const blocks = source.split("[[permission]]").slice(1);
  const block = blocks.find((candidate) => candidate.includes(`identifier = "${identifier}"`));
  if (!block) throw new Error(`Unable to find the ${identifier} permission.`);
  const commands = block.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1];
  if (!commands) throw new Error(`Unable to find commands.allow for ${identifier}.`);
  return [...commands.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function capabilityPermissions(filename: string): string[] {
  return JSON.parse(read(`capabilities/${filename}`)).permissions as string[];
}

describe("desktop native command permissions", () => {
  test("keeps the registered command manifest and main-window permission in sync", () => {
    const registered = registeredCommandNames();
    const manifest = manifestCommandNames();

    expect(manifest).toEqual(registered);
    expect(permissionCommands("main-app-commands")).toEqual(manifest);
    expect(capabilityPermissions("default.json")).toContain("main-app-commands");
  });

  test("grants quick chat only the commands used by its chat workflow", () => {
    expect(permissionCommands("desktop-pet-quick-chat-app-commands")).toEqual([
      "record_renderer_diagnostic",
      "record_renderer_log",
      "get_settings_snapshot",
      "get_config_editor_snapshot",
      "pick_chat_files",
      "worker_webui_route",
      "worker_threads_list",
      "worker_thread_create",
      "worker_thread_update_metadata",
      "thread_list_turns",
      "thread_get_turn_runtime_state",
      "worker_submit_thread_turn",
      "worker_thread_interrupt",
    ]);
    expect(capabilityPermissions("desktop-pet-chat.json")).toContain(
      "desktop-pet-quick-chat-app-commands",
    );
    expect(capabilityPermissions("desktop-pet.json")).not.toContain("main-app-commands");
    expect(capabilityPermissions("desktop-pet.json")).not.toContain(
      "desktop-pet-quick-chat-app-commands",
    );
    expect(permissionCommands("desktop-pet-drop-app-commands")).toEqual([
      "desktop_pet_drop_signal",
    ]);
    expect(capabilityPermissions("desktop-pet.json")).toContain(
      "desktop-pet-drop-app-commands",
    );
  });
});
