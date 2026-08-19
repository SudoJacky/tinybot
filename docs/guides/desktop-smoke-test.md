# Windows Desktop Smoke Test

Use this checklist after changes to desktop startup, Chat composition, Sidecar,
native Browser or Terminal resources, window layout, or native resource
lifecycle. It covers behavior that unit tests and Linux CI cannot prove because
it depends on a real Windows desktop, WebView2, PTY processes, and native child
window geometry.

This is a smoke test, not a release certification suite. Run the sections
affected by a focused change; run the complete checklist before a desktop
release or after a cross-cutting native integration change.

## Prerequisites

- Windows with the Microsoft Edge WebView2 Runtime installed.
- Node.js, npm, Rust, and the Tauri 2 Windows prerequisites from the
  [desktop guide](../desktop.md).
- A configured provider when testing shared Agent Browser control.
- One regular conversation and one conversation bound to a known workspace.
- A workspace containing a recognizable file so its working directory can be
  distinguished from Tinybot's configured default workspace.

Record the commit, Windows version, display scale, initial window size, and
whether the conversation uses an explicit or default workspace. These details
matter for native surface and layout failures.

## Automated preflight

Run the relevant automated checks before manual testing:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml -j 4 --lib -- --test-threads=1
```

For Browser runtime changes, also run the real WebView2 integration harness
from an interactive Windows desktop:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml -j 4 --features native-browser-integration --bin native-browser-integration
```

Start the development desktop:

```powershell
npm run tauri -- dev
```

## Startup and conversation baseline

1. Launch Tinybot and wait for Chat to become interactive.
2. Open the regular conversation and the explicit-workspace conversation.
3. Send a short message in each conversation.
4. Switch between them several times.

Pass when startup does not expose a backend-readiness error, both conversations
remain usable, and switching does not duplicate or lose the canonical Chat
timeline.

## Sidecar resource shell

1. Open the new Sidecar resource menu and create one Browser resource.
2. Confirm that one action creates exactly one Sidecar tab.
3. Create a PowerShell or Command Prompt resource and switch repeatedly between
   it and the Browser.
4. Hide and show Sidecar, then return to each resource.
5. Create a second Browser resource and switch repeatedly between both Browser
   tabs for at least 15 seconds.
6. Drag the divider continuously to the left until Chat reaches its minimum
   usable width. Keep dragging for several seconds, then drag it back.
7. Resize the desktop window across the narrow overlay breakpoint and repeat
   the divider test.
8. Leave Sidecar wide, close Tinybot, relaunch it at a narrower window size,
   and open Sidecar again.

Pass when resource creation never duplicates a tab, tab selection remains
stable, memory does not climb continuously while switching, hidden resources
reattach, and neither Chat nor the resource surface drifts beyond or disappears
behind the right edge. A restored width must be clamped to the current Chat
workspace rather than its previous window.

## Shared Browser resource

1. Create a Browser resource and wait until its preparing state becomes an
   interactive page.
2. Navigate to `https://example.com` from the address bar.
3. Exercise Back, Forward, Reload, focus, typing, scrolling, and direct pointer
   input.
4. Switch to a Terminal resource, then return to Browser.
5. Hide and show Sidecar, then switch to another conversation and back.
6. With a provider configured, ask the Agent to inspect the current page and
   perform a harmless navigation or interaction. Confirm that the visible
   Browser reflects the same tab and page state.
7. While an Agent Browser action is pending, interact directly with the page.
   Confirm that control returns to the user without a stale Agent action
   overriding newer user input.
8. Create a Browser in a second conversation and verify that it does not attach
   to the first conversation's session.
9. Close one Browser resource while another remains, then close the last one.

Pass when the preparing state resolves without manual reload, one Sidecar
Browser resource maps to one native tab, returning to a retained resource
reattaches its page, user and Agent actions share the intended session, direct
user input invalidates stale Agent control, and conversation ownership is not
crossed.

## User-only Terminal resource

Run this section once in the regular conversation and once in the
explicit-workspace conversation.

1. Create PowerShell and run `Get-Location`, `echo tinybot-terminal`, and a
   command that produces several screens of output.
2. Confirm that the regular conversation opens in Tinybot's configured default
   workspace and the explicit conversation opens in its workspace.
3. Resize Sidecar and the desktop window while output is visible.
4. Run `ping -t 127.0.0.1`, switch to another resource, hide Sidecar, then
   return and stop it with Ctrl+C.
5. Close the Terminal resource and create a new one with the same shell.
6. Create Command Prompt and repeat the working-directory and input/output
   checks with `cd` and `echo tinybot-terminal`.
7. Run an Agent shell command and confirm that its input, output, and process
   lifecycle do not appear in the user Terminal; likewise, Terminal output must
   not appear as Agent tool output.

Pass when input is serialized, output is not duplicated or lost across
reattachment, resizing fits the terminal, hiding and tab switching preserve the
PTY, closing the resource terminates it, a new resource starts a fresh process,
and Agent shell sessions remain isolated.

## Shutdown cleanup

1. In a Sidecar PowerShell resource, run `$PID` and record the process ID.
2. Start a long-running command and close the Tinybot window normally.
3. From an external PowerShell window, run `Get-Process -Id <recorded-pid>`.
4. Relaunch Tinybot and create fresh Browser and Terminal resources.

Pass when the recorded Terminal process no longer exists after shutdown and a
new launch can provision native resources without inheriting stale lifecycle
state.

## Failure evidence

For any failure, capture:

- the first failing checklist step and the smallest reliable reproduction;
- expected and actual behavior;
- conversation workspace kind: explicit or default;
- window size, display scale, and whether Sidecar was docked or overlaid;
- a screenshot or short recording for geometry or feedback-loop failures;
- process ID and exit behavior for Terminal cleanup failures;
- the diagnostic bundle from System > Performance Trace when available.

Do not include provider credentials, cookies, page contents containing private
data, Terminal secrets, or complete prompts in an issue or diagnostic sample.

## Related documentation

- [Desktop development and runtime boundaries](../desktop.md)
- [System architecture](../architecture/system-overview.md)
- [Native Browser runtime](../../src-tauri/src/native_browser/README.md)
- [Desktop command reference](../api/desktop.md)
