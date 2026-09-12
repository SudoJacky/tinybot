const LANGUAGES_BY_EXTENSION = new Map(Object.entries({
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  py: "python", pyw: "python", pyi: "python", rs: "rust", go: "go",
  c: "c", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  rb: "ruby", php: "php", lua: "lua", r: "r", dart: "dart",
  sh: "bash", bash: "bash", zsh: "zsh", ps1: "powershell", psm1: "powershell", bat: "bat", cmd: "bat",
  json: "json", jsonc: "jsonc", json5: "json5", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  html: "html", htm: "html", xml: "xml", svg: "xml", css: "css", scss: "scss", less: "less",
  vue: "vue", svelte: "svelte", sql: "sql", graphql: "graphql", gql: "graphql",
  diff: "diff", patch: "diff", dockerfile: "dockerfile",
}));

const LANGUAGES_BY_FILENAME = new Map(Object.entries({
  dockerfile: "dockerfile", containerfile: "dockerfile", makefile: "make", gnumakefile: "make",
  "cmakelists.txt": "cmake", ".bashrc": "bash", ".bash_profile": "bash", ".zshrc": "zsh",
}));

const LANGUAGES_BY_MIME_TYPE = new Map(Object.entries({
  "text/javascript": "javascript", "application/javascript": "javascript",
  "text/typescript": "typescript", "application/typescript": "typescript",
  "application/json": "json", "application/ld+json": "json",
  "application/yaml": "yaml", "text/yaml": "yaml", "application/toml": "toml",
  "text/html": "html", "text/css": "css", "application/xml": "xml", "text/xml": "xml",
  "text/x-python": "python", "text/x-rust": "rust", "text/x-shellscript": "bash",
}));

export function resolveCodeArtifactLanguage({ path, title, mimeType }: {
  path?: string;
  title?: string;
  mimeType?: string;
}): string | undefined {
  const filename = (path || title || "").split(/[\\/]/).pop()!.toLowerCase();
  const extension = /\.([^.]+)$/.exec(filename)?.[1] ?? "";
  // Extensions distinguish JSX/TSX from their less specific MIME types.
  return LANGUAGES_BY_FILENAME.get(filename) ?? LANGUAGES_BY_EXTENSION.get(extension)
    ?? LANGUAGES_BY_MIME_TYPE.get(mimeType?.split(";", 1)[0].trim().toLowerCase() ?? "");
}
