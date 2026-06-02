# Gateway Service

The gateway service enables Tinybot to run continuously and provides entry points for web UI, chat platforms, scheduled tasks, and heartbeat services. In short: if you want browser access to Tinybot, you usually need to run the gateway.

## When you need the gateway

| Scenario | Requires gateway |
|------|----------|
| Temporary CLI chat | No, use `uv run tinybot agent` |
| Web UI | Yes |
| Feishu, DingTalk, WeChat channels | Yes |
| Scheduled tasks and heartbeat long-run service | Yes |
| OpenAI-compatible API | No, use `uv run tinybot api` |

## Start the gateway

```bash
uv run tinybot gateway
```

If WebSocket channel is enabled, open in browser:

```text
http://127.0.0.1:18790
```

## Enable web channel

Your configuration must include:
```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18790
    }
  }
}
```

`127.0.0.1` means local-only access, which is suitable for personal use. Do not expose the service to the public internet unless you understand the security impact.

## Change port

If `18790` is occupied, temporarily specify another port:

```bash
uv run tinybot gateway --port 18800
```

You can also change the WebSocket channel settings:

```json
{
  "channels": {
    "websocket": {
      "enabled": true,
      "host": "127.0.0.1",
      "port": 18800
    }
  }
}
```

Then open:

```text
http://127.0.0.1:18800
```

## Connect chat platforms

Tinybot has built-in channels for Feishu, DingTalk, WeChat, etc. After configuring those channels, gateway receives platform messages and forwards them to agents.

Typical flow:

1. Create an app in the corresponding platform
2. Obtain required IDs, secrets, tokens
3. Enable the corresponding channel under `channels`
4. Start `uv run tinybot gateway`
5. Finish callback URL / login configuration on platform side

Example structure:
Fields differ by platform; follow each channel’s configuration.

```json
{
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "your App ID",
      "appSecret": "your App Secret"
    }
  }
}
```

Fields differ by platform; follow each channel’s configuration.

## Heartbeat service

Gateway includes heartbeat service for periodic maintenance, such as memory cleanup and background task checks.

Related config:

```json
{
  "gateway": {
    "heartbeat": {
      "enabled": true,
      "intervalS": 1800,
      "keepRecentMessages": 8
    }
  }
}
```

Beginner default is fine.
## Scheduled tasks

After gateway starts, Tinybot can process scheduled tasks. For example in conversation you can say:
```text
Remind me every day at 9:00 AM to check my to-do list.
```

Scheduled tasks require gateway to keep running; stopping terminal stops these tasks.

## Troubleshooting

### Web UI cannot open

Check:

1. Whether `uv run tinybot gateway` is still running
2. Whether WebSocket channel is enabled
3. Whether the port is correct
4. Whether firewall is blocking access

### Gateway starts but no UI

Usually `channels.websocket.enabled` is not enabled, or `staticDir` points to missing web files.

### Other devices in LAN cannot access

Set `host` to `0.0.0.0` and ensure firewall allows access to the port. Do this only on trusted networks.

## Next steps

- [Web UI](webui.md): chat with Tinybot in browser
- [Configuration](config.md): learn gateway and channel settings
- [Task system](tasks.md): use scheduled tasks and complex workflows
