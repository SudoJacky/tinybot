# Tinybot MCP configuration reference

Tinybot supports global MCP servers using `stdio` and `streamable-http`. Always call provider tool `mcp_config_list` first and pass its `revision` to `mcp_config_upsert` as `expectedRevision`; their Tinybot method IDs are `mcp.config.list` and `mcp.config.upsert`.

## Streamable HTTP

```json
{
  "name": "docs",
  "expectedRevision": "<revision from list>",
  "server": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp",
    "bearerTokenEnvVar": "MCP_BEARER_TOKEN",
    "httpHeaders": { "X-Region": "sg" },
    "envHttpHeaders": { "X-Api-Key": "MCP_API_KEY" }
  }
}
```

- `url` must use HTTP or HTTPS and cannot include credentials or a fragment.
- `bearerTokenEnvVar` names a host environment variable whose value becomes the bearer token.
- `httpHeaders` contains only non-sensitive literal headers.
- `envHttpHeaders` maps an HTTP header name to a host environment variable name.

## stdio

```json
{
  "name": "sqlite",
  "expectedRevision": "<revision from list>",
  "server": {
    "transport": "stdio",
    "command": "uvx",
    "args": ["mcp-server-sqlite", "--db-path", "data.db"],
    "cwd": ".",
    "env": { "LOG_LEVEL": "info" },
    "envVarRefs": { "API_TOKEN": "SQLITE_MCP_TOKEN" }
  }
}
```

- `command` is the executable; each command-line argument is a separate `args` item.
- `cwd` may be absolute or relative to the active Agent working directory and must exist when the server starts.
- `env` contains only non-sensitive literal values.
- `envVarRefs` maps the child process variable name to a host environment variable name.
- Never put a credential in `args` or `env`.

Both transports are saved enabled with all discovered tools allowed. A successful upsert returns `configured: true` even when its nested runtime status reports a connection error. The next Agent turn refreshes the model-visible MCP tool catalog.

If list output reports `bearerTokenConfigured`, `sensitiveHttpHeaderNames`, or `sensitiveEnvNames`, the values are intentionally hidden. Update that server in **Tools & Plugins → MCP** instead of replacing it through the Agent.
