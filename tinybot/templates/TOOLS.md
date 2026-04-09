# Tool Usage Notes

Tool signatures are provided automatically via function calling.
This file documents non-obvious constraints and usage patterns.

## exec — Safety Limits

- Commands have a configurable timeout (default 60s)
- Dangerous commands are blocked (rm -rf, format, dd, shutdown, etc.)
- Output is truncated at 10,000 characters
- `restrictToWorkspace` config can limit file access to the workspace

## cron — Scheduled Reminders

- Please refer to cron skill for usage.

## browser_control — Browser Automation

- Always call `snapshot` first to get element ref IDs, then use `ref` for click/type/etc.
- `ref`-based locating is more stable than CSS selectors.
- `open` auto-starts the browser if not running (headless by default).
- Use `headed=true` in `start` to see the browser window (for debugging).
- Cookies, localStorage, and session data persist across browser restarts.
- Browser auto-closes after 600s of inactivity (configurable via `browserTools.idleTimeout`).
- All actions operate on a specific `page_id` tab (default: "page_1").
