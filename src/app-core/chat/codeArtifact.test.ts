import { describe, expect, it } from "vitest";
import { code } from "@streamdown/code";
import { resolveCodeArtifactLanguage } from "./codeArtifact";

describe("code artifact languages", () => {
  it.each([
    ["src/main.ts", "typescript"], ["src/App.TSX", "tsx"], ["app.jsx", "jsx"],
    ["scripts/run.py", "python"], ["src/main.rs", "rust"], ["main.go", "go"],
    ["main.cpp", "cpp"], ["main.cs", "csharp"], ["Main.java", "java"],
    ["style.css", "css"], ["theme.scss", "scss"], ["page.html", "html"], ["icon.svg", "xml"],
    ["config.json", "json"], ["settings.jsonc", "jsonc"], ["config.yaml", "yaml"], ["Cargo.toml", "toml"],
    ["run.sh", "bash"], ["run.ps1", "powershell"], ["run.cmd", "bat"], ["query.sql", "sql"],
    ["D:\\项目\\Dockerfile", "dockerfile"], ["Makefile", "make"], ["CMakeLists.txt", "cmake"],
    [".zshrc", "zsh"], ["App.vue", "vue"], ["App.svelte", "svelte"],
  ])("selects a supported highlighter for %s", (path, language) => {
    expect(resolveCodeArtifactLanguage({ path })).toBe(language);
    expect(code.supportsLanguage(language as Parameters<typeof code.supportsLanguage>[0])).toBe(true);
  });

  it("uses MIME types for unnamed artifacts but preserves TSX/JSX from the filename", () => {
    expect(resolveCodeArtifactLanguage({ title: "Result", mimeType: "Application/JSON; charset=utf-8" })).toBe("json");
    expect(resolveCodeArtifactLanguage({ title: "App.tsx", mimeType: "text/typescript" })).toBe("tsx");
    expect(resolveCodeArtifactLanguage({ path: "App.jsx", mimeType: "text/javascript" })).toBe("jsx");
  });

  it.each(["README.md", "table.csv", "notes.txt", "unknown.xyz", "constructor", "toString"])("leaves %s to its existing preview", (path) => {
    expect(resolveCodeArtifactLanguage({ path, mimeType: "text/plain" })).toBeUndefined();
  });
});
