"""Browser automation tool based on Playwright.

Provides a single ``browser_control`` tool with an ``action`` parameter
to start/stop the browser, navigate pages, interact with elements, take
screenshots, and more.

Element locating priority:
1. **ref** — stable reference ID from the latest ``snapshot``
2. **selector** — CSS / Playwright selector string
3. **element** — natural-language description (for LLM-generated queries)
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

from tinybot.agent.tools.base import Tool, tool_parameters
from tinybot.agent.tools.schema import (
    BooleanSchema,
    IntegerSchema,
    NumberSchema,
    StringSchema,
    tool_parameters_schema,
)

if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page, Playwright

# ---------------------------------------------------------------------------
# Action list (used for parameter enum generation)
# ---------------------------------------------------------------------------
_ALL_ACTIONS: list[str] = [
    # Basic operations
    "start",
    "stop",
    "open",
    "navigate",
    "close",
    # Page interaction
    "snapshot",
    "click",
    "type",
    "hover",
    "drag",
    "select_option",
    "press_key",
    # Information
    "screenshot",
    "evaluate",
    "console_messages",
    "network_requests",
    "pdf",
    # Advanced
    "handle_dialog",
    "file_upload",
    "fill_form",
    "tabs",
    "wait_for",
    "resize",
    "cookies_get",
    "cookies_set",
    "cookies_clear",
    "connect_cdp",
]

# ---------------------------------------------------------------------------
# Ref-based element locator
# ---------------------------------------------------------------------------

def _build_snapshot_js() -> str:
    """Return JavaScript that produces a compact accessibility / DOM snapshot."""
    return """
(() => {
    const interactiveTags = new Set([
        'a','button','input','textarea','select','option','details',
        'summary','dialog','iframe','object','embed','video','audio',
        '[role="button"]','[role="link"]','[role="textbox"]','[role="checkbox"]',
        '[role="radio"]','[role="combobox"]','[role="listbox"]','[role="menu"]',
        '[role="menuitem"]','[role="tab"]','[role="slider"]','[role="switch"]'
    ]);

    function getSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('__')).join('.');
            if (cls) return el.tagName.toLowerCase() + '.' + cls;
        }
        return el.tagName.toLowerCase();
    }

    function walk(root, prefix) {
        const items = [];
        const children = root.querySelectorAll('*');
        let refIdx = 0;
        for (const el of children) {
            if (el.shadowRoot) {
                const shadowItems = walk(el.shadowRoot, prefix + 'e' + refIdx + '-');
                refIdx += shadowItems.length;
                items.push(...shadowItems);
                continue;
            }
            const tag = el.tagName.toLowerCase();
            const role = (el.getAttribute('role') || '').toLowerCase();
            const attrs = [];
            if (el.id) attrs.push('id=' + el.id);
            const type = el.getAttribute('type');
            if (type) attrs.push('type=' + type);
            const name = el.getAttribute('name');
            if (name) attrs.push('name=' + name);
            const href = el.getAttribute('href');
            if (href) attrs.push('href=' + href.substring(0, 80));
            const value = el.value || el.textContent || '';
            const display = value.trim().substring(0, 60);
            if (display || interactiveTags.has(tag) || interactiveTags.has('[role="' + role + '"]') || el.onclick || el.tabIndex >= 0) {
                const ref = prefix + 'e' + refIdx;
                items.push({
                    ref: ref,
                    tag: tag,
                    role: role || undefined,
                    name: el.name || undefined,
                    type: type || undefined,
                    text: display || undefined,
                    placeholder: el.placeholder || undefined,
                    href: href ? href.substring(0, 200) : undefined,
                    checked: el.checked || undefined,
                    disabled: el.disabled || undefined,
                    visible: el.offsetParent !== null
                });
                refIdx++;
            }
        }
        return items;
    }

    return JSON.stringify(walk(document, ''));
})();
"""


def _element_from_ref(elements: dict[str, dict[str, Any]], ref: str) -> dict[str, Any] | None:
    """Look up an element dict by its ref."""
    return elements.get(ref)


def _selector_from_ref(elements: dict[str, dict[str, Any]], ref: str) -> str | None:
    """Build a robust CSS selector chain for a given ref element."""
    el = elements.get(ref)
    if not el:
        return None
    tag = el.get("tag", "")
    el_id = el.get("id")
    if el_id:
        return f"#{el_id}"
    el_name = el.get("name")
    if el_name:
        return f"{tag}[name='{el_name}']"
    el_type = el.get("type")
    if el_type and tag == "input":
        return f"{tag}[type='{el_type}']"
    # Fallback: find by text content
    text = el.get("text")
    if text:
        if tag == "a":
            return f"a:has-text('{text}')"
        if tag == "button":
            return f"button:has-text('{text}')"
        return f"{tag}:has-text('{text}')"
    return tag


# ---------------------------------------------------------------------------
# Browser session manager
# ---------------------------------------------------------------------------

class BrowserSession:
    """Manages a single Playwright browser context lifecycle."""

    def __init__(
        self,
        user_data_dir: Path,
        idle_timeout: int = 600,
        proxy: str | None = None,
    ) -> None:
        self.user_data_dir = user_data_dir
        self.idle_timeout = idle_timeout
        self.proxy = proxy
        self._playwright: Playwright | None = None
        self._context: BrowserContext | None = None
        self._pages: dict[str, Page] = {}
        self._page_counter = 0
        self._last_activity = time.monotonic()
        self._idle_task: asyncio.Task | None = None
        self._console_logs: list[dict[str, Any]] = []
        self._network_requests: list[dict[str, Any]] = []
        self._snapshot_elements: dict[str, dict[str, Any]] = {}

    @property
    def is_running(self) -> bool:
        return self._context is not None

    @property
    def context(self) -> BrowserContext | None:
        return self._context

    @property
    def snapshot_elements(self) -> dict[str, dict[str, Any]]:
        return self._snapshot_elements

    async def start(self, *, headed: bool = False, cdp_port: int | None = None) -> str:
        """Launch browser (idempotent). Returns status message."""
        if self._context:
            state = "headed" if headed else "headless"
            return f"Browser is already running ({state} mode)"

        self._touch()
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            return (
                "Error: playwright is not installed. "
                "Install it with: pip install playwright && playwright install chromium"
            )

        self._playwright = await async_playwright().start()

        # Detect system browser
        executable_path = self._find_chrome()
        browser_type = "chromium"
        launch_kwargs: dict[str, Any] = {
            "headless": not headed,
            "args": self._build_launch_args(cdp_port),
        }
        if executable_path:
            launch_kwargs["executable_path"] = executable_path

        self.user_data_dir.mkdir(parents=True, exist_ok=True)
        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.user_data_dir),
            **launch_kwargs,
        )

        # Monitor console & network
        self._context.on("console", self._on_console)
        self._context.on("request", self._on_request)

        # Start idle timer
        if self.idle_timeout > 0:
            self._idle_task = asyncio.create_task(self._idle_watcher())

        self._snapshot_elements.clear()
        self._console_logs.clear()
        self._network_requests.clear()

        mode = "headed" if headed else "headless"
        return f"Browser started ({mode} mode, user_data: {self.user_data_dir})"

    async def stop(self) -> str:
        """Close browser and clean up (idempotent)."""
        if not self._context:
            return "Browser is not running"

        self._cancel_idle()
        try:
            await self._context.close()
        except Exception:
            pass
        self._context = None
        self._pages.clear()
        self._page_counter = 0
        self._snapshot_elements.clear()
        if self._playwright:
            try:
                await self._playwright.stop()
            except Exception:
                pass
            self._playwright = None
        return "Browser stopped"

    async def open(self, url: str, page_id: str | None = None) -> str:
        """Open a URL in a new tab (starts browser if needed)."""
        if not self._context:
            result = await self.start()
            if result.startswith("Error"):
                return result

        assert self._context is not None
        self._touch()
        self._page_counter += 1
        pid = page_id or f"page_{self._page_counter}"

        if pid in self._pages:
            await self._pages[pid].goto(url, wait_until="domcontentloaded")
            return f"Navigated existing tab '{pid}' to {url}"

        page = await self._context.new_page()
        await page.goto(url, wait_until="domcontentloaded")
        self._pages[pid] = page
        self._snapshot_elements.clear()
        return f"Opened {url} in new tab '{pid}'"

    async def navigate(self, url: str, page_id: str = "page_1") -> str:
        """Navigate an existing tab to a new URL."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()
        self._snapshot_elements.clear()
        await page.goto(url, wait_until="domcontentloaded")
        return f"Navigated tab '{page_id}' to {url}"

    async def close_tab(self, page_id: str) -> str:
        """Close a specific tab."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()
        await page.close()
        del self._pages[page_id]
        if page_id in self._snapshot_elements:
            del self._snapshot_elements[page_id]
        return f"Closed tab '{page_id}'"

    async def snapshot(self, page_id: str = "page_1") -> str:
        """Get interactive element tree for a page."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        try:
            elements_json = await page.evaluate(_build_snapshot_js())
            elements: list[dict[str, Any]] = json.loads(elements_json) if isinstance(elements_json, str) else elements_json
        except Exception as e:
            return f"Error: Failed to get snapshot: {e}"

        visible = [el for el in elements if el.get("visible", True)]
        elements_map: dict[str, dict[str, Any]] = {}
        lines: list[str] = []
        for el in visible:
            ref = el["ref"]
            elements_map[ref] = el
            tag = el.get("tag", "")
            role = el.get("role", "")
            text = el.get("text", "")
            name = el.get("name", "")
            el_type = el.get("type", "")
            placeholder = el.get("placeholder", "")
            checked = el.get("checked")
            disabled = el.get("disabled", False)

            desc_parts: list[str] = []
            if role:
                desc_parts.append(role)
            if tag:
                desc_parts.append(tag)
            if el_type and tag != el_type:
                desc_parts.append(f"type={el_type}")
            if name:
                desc_parts.append(f'name="{name}"')
            desc = " ".join(desc_parts)

            text_parts: list[str] = []
            if text:
                text_parts.append(f'"{text}"')
            if placeholder:
                text_parts.append(f'placeholder="{placeholder}"')
            if checked is not None:
                text_parts.append("checked" if checked else "unchecked")
            if disabled:
                text_parts.append("disabled")

            text_str = " ".join(text_parts)
            lines.append(f"  {desc} {text_str} [ref={ref}]" if text_str else f"  {desc} [ref={ref}]")

        self._snapshot_elements[page_id] = elements_map
        if not lines:
            return f"Page '{page_id}': no interactive elements found"
        return f"Page '{page_id}' snapshot ({len(lines)} elements):\n" + "\n".join(lines)

    async def click(self, ref: str | None = None, selector: str | None = None, page_id: str = "page_1") -> str:
        """Click an element by ref or selector."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if loc is None:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            await page.click(loc, timeout=10000)
            self._snapshot_elements.pop(page_id, None)
            return f"Clicked element [ref={ref}]"
        except Exception as e:
            return f"Error: Click failed: {e}"

    async def type_text(
        self,
        ref: str | None = None,
        selector: str | None = None,
        text: str = "",
        slowly: bool = False,
        page_id: str = "page_1",
    ) -> str:
        """Type text into an element by ref or selector."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if loc is None:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            await page.click(loc, timeout=5000)
            if slowly:
                await page.keyboard.type(text, delay=50)
            else:
                await page.fill(loc, text)
            self._snapshot_elements.pop(page_id, None)
            return f"Typed '{text[:50]}' into element [ref={ref}]"
        except Exception as e:
            return f"Error: Type failed: {e}"

    async def hover(self, ref: str | None = None, selector: str | None = None, page_id: str = "page_1") -> str:
        """Hover over an element by ref or selector."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if loc is None:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            await page.hover(loc, timeout=10000)
            return f"Hovered over element [ref={ref}]"
        except Exception as e:
            return f"Error: Hover failed: {e}"

    async def drag(
        self,
        start_ref: str | None = None,
        end_ref: str | None = None,
        start_selector: str | None = None,
        end_selector: str | None = None,
        page_id: str = "page_1",
    ) -> str:
        """Drag an element to another location."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        start_loc = self._resolve(start_ref, start_selector, page_id)
        end_loc = self._resolve(end_ref, end_selector, page_id)
        if not start_loc or not end_loc:
            return f"Error: Cannot locate drag source or target"
        try:
            await page.drag_and_drop(start_loc, end_loc, timeout=10000)
            self._snapshot_elements.pop(page_id, None)
            return f"Dragged [ref={start_ref}] to [ref={end_ref}]"
        except Exception as e:
            return f"Error: Drag failed: {e}"

    async def select_option(
        self,
        ref: str | None = None,
        selector: str | None = None,
        values: str = "",
        page_id: str = "page_1",
    ) -> str:
        """Select option(s) in a dropdown."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if loc is None:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            vals = json.loads(values) if values.startswith("[") else [values]
            await page.select_option(loc, values=vals, timeout=10000)
            self._snapshot_elements.pop(page_id, None)
            return f"Selected {vals} in [ref={ref}]"
        except Exception as e:
            return f"Error: Select failed: {e}"

    async def press_key(self, key: str, page_id: str = "page_1") -> str:
        """Press a keyboard key or key combination."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()
        try:
            await page.keyboard.press(key)
            return f"Pressed key '{key}'"
        except Exception as e:
            return f"Error: Key press failed: {e}"

    async def screenshot(
        self,
        page_id: str = "page_1",
        path: str | None = None,
        full_page: bool = False,
    ) -> str:
        """Take a screenshot of the current page."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        screenshot_path = Path(path) if path else self.user_data_dir / f"screenshot_{page_id}_{int(time.time())}.png"
        screenshot_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await page.screenshot(path=str(screenshot_path), full_page=full_page)
            return f"Screenshot saved to {screenshot_path}"
        except Exception as e:
            return f"Error: Screenshot failed: {e}"

    async def evaluate(
        self,
        code: str,
        ref: str | None = None,
        selector: str | None = None,
        page_id: str = "page_1",
    ) -> str:
        """Execute JavaScript on the page."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        try:
            if ref or selector:
                loc = self._resolve(ref, selector, page_id)
                if loc is None:
                    return f"Error: Cannot locate element (ref={ref}, selector={selector})"
                result = await page.evaluate(f"(el) => {{ {code} }}", await page.query_selector(loc))
            else:
                result = await page.evaluate(code)
            return json.dumps(result, ensure_ascii=False, default=str) if not isinstance(result, str) else result
        except Exception as e:
            return f"Error: JS evaluation failed: {e}"

    async def console_messages(self, level: str | None = None, page_id: str = "page_1") -> str:
        """Get console log messages, optionally filtered by level."""
        self._touch()
        logs = self._console_logs
        if level:
            logs = [l for l in logs if l.get("type", "").lower() == level.lower()]
        if not logs:
            return "No console messages recorded"
        # Return last 50
        recent = logs[-50:]
        lines = [f"[{l.get('type','log')}] {l.get('text','')}" for l in recent]
        return f"Console messages ({len(recent)} shown):\n" + "\n".join(lines)

    async def network_requests(self, include_static: bool = False, page_id: str = "page_1") -> str:
        """Get network request log."""
        self._touch()
        reqs = self._network_requests
        if not include_static:
            static_exts = {".css", ".js", ".png", ".jpg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf"}
            reqs = [r for r in reqs if not any(r.get("url", "").lower().endswith(ext) for ext in static_exts)]
        if not reqs:
            return "No network requests recorded"
        recent = reqs[-30:]
        lines = [f"[{r.get('method','GET')}] {r.get('url','')[:120]} ({r.get('status','?')})" for r in recent]
        return f"Network requests ({len(recent)} shown):\n" + "\n".join(lines)

    async def pdf(self, path: str, page_id: str = "page_1") -> str:
        """Export the current page as PDF."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        pdf_path = Path(path) if path else self.user_data_dir / f"page_{page_id}_{int(time.time())}.pdf"
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            await page.pdf(path=str(pdf_path), format="A4")
            return f"PDF saved to {pdf_path}"
        except Exception as e:
            return f"Error: PDF export failed: {e}"

    async def handle_dialog(self, accept: bool = True, text: str = "", page_id: str = "page_1") -> str:
        """Handle the next dialog (alert/confirm/prompt)."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        async def _wait_dialog():
            dialog = await page.wait_for_event("dialog", timeout=10000)
            if text:
                await dialog.accept(prompt_text=text)
            elif accept:
                await dialog.accept()
            else:
                await dialog.dismiss()
            return f"Dialog handled: accept={accept}, message='{dialog.message[:80]}'"

        try:
            return await _wait_dialog()
        except Exception as e:
            return f"Error: No dialog appeared: {e}"

    async def file_upload(
        self,
        ref: str | None = None,
        selector: str | None = None,
        file_paths: str = "",
        page_id: str = "page_1",
    ) -> str:
        """Upload files to a file input element."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if loc is None:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            paths = [p.strip() for p in file_paths.split(",")]
            await page.set_input_files(loc, paths)
            return f"Uploaded {len(paths)} file(s) to [ref={ref}]"
        except Exception as e:
            return f"Error: File upload failed: {e}"

    async def fill_form(self, fields: str, page_id: str = "page_1") -> str:
        """Fill multiple form fields at once. fields is JSON: {\"ref1\": \"value1\", ...}"""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        try:
            mapping = json.loads(fields)
        except json.JSONDecodeError as e:
            return f"Error: Invalid JSON for fields: {e}"

        results: list[str] = []
        for ref, value in mapping.items():
            sel = _selector_from_ref(self._snapshot_elements.get(page_id, {}), ref)
            if not sel:
                results.append(f"  {ref}: Error - ref not found")
                continue
            try:
                await page.fill(sel, str(value), timeout=5000)
                results.append(f"  {ref}: filled '{str(value)[:30]}'")
            except Exception as e:
                results.append(f"  {ref}: Error - {e}")
        self._snapshot_elements.pop(page_id, None)
        return "Form fill results:\n" + "\n".join(results)

    async def tabs_list(self) -> str:
        """List all open tabs."""
        if not self._context:
            return "Browser is not running"
        self._touch()
        if not self._pages:
            return "No open tabs"
        lines: list[str] = []
        for pid, page in self._pages.items():
            try:
                title = await page.title()
                url = page.url
                lines.append(f"  [{pid}] {title or '(no title)'} - {url[:80]}")
            except Exception:
                lines.append(f"  [{pid}] (page may be closed)")
        return f"Open tabs ({len(lines)}):\n" + "\n".join(lines)

    async def wait_for(
        self,
        condition: str = "visible",
        ref: str | None = None,
        selector: str | None = None,
        timeout: int = 30000,
        page_id: str = "page_1",
    ) -> str:
        """Wait for a condition on an element."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()

        loc = self._resolve(ref, selector, page_id)
        if not loc:
            return f"Error: Cannot locate element (ref={ref}, selector={selector})"
        try:
            await page.wait_for_selector(loc, state=condition, timeout=timeout)
            return f"Wait satisfied: {condition} for [ref={ref}]"
        except Exception as e:
            return f"Error: Wait failed: {e}"

    async def resize(self, width: int = 1280, height: int = 720, page_id: str = "page_1") -> str:
        """Resize the viewport."""
        page = self._get_page(page_id)
        if not page:
            return f"Error: Tab '{page_id}' not found. Available: {list(self._pages.keys())}"
        self._touch()
        try:
            await page.set_viewport_size({"width": width, "height": height})
            return f"Viewport resized to {width}x{height}"
        except Exception as e:
            return f"Error: Resize failed: {e}"

    async def cookies_get(self, page_id: str = "page_1") -> str:
        """Get all cookies for the current page."""
        if not self._context:
            return "Error: Browser is not running"
        self._touch()
        try:
            cookies = await self._context.cookies()
            if not cookies:
                return "No cookies found"
            lines = [f"  {c.get('name', '')}={c.get('value', '')[:40]} (domain: {c.get('domain', '')})" for c in cookies]
            return f"Cookies ({len(lines)}):\n" + "\n".join(lines)
        except Exception as e:
            return f"Error: Failed to get cookies: {e}"

    async def cookies_set(self, cookies_json: str, page_id: str = "page_1") -> str:
        """Set cookies. cookies_json is JSON array of cookie objects."""
        if not self._context:
            return "Error: Browser is not running"
        self._touch()
        try:
            cookies = json.loads(cookies_json)
            if isinstance(cookies, dict):
                cookies = [cookies]
            await self._context.add_cookies(cookies)
            return f"Set {len(cookies)} cookie(s)"
        except Exception as e:
            return f"Error: Failed to set cookies: {e}"

    async def cookies_clear(self, page_id: str = "page_1") -> str:
        """Clear all cookies."""
        if not self._context:
            return "Error: Browser is not running"
        self._touch()
        try:
            await self._context.clear_cookies()
            return "All cookies cleared"
        except Exception as e:
            return f"Error: Failed to clear cookies: {e}"

    async def connect_cdp(self, cdp_url: str) -> str:
        """Connect to an already-running Chrome via CDP."""
        if self._context:
            return "Error: Browser is already running. Stop it first."
        self._touch()
        try:
            from playwright.async_api import async_playwright
            self._playwright = await async_playwright().start()
            browser = await self._playwright.chromium.connect_over_cdp(cdp_url)
            self._context = await browser.new_context()
            return f"Connected to Chrome via CDP: {cdp_url}"
        except Exception as e:
            return f"Error: CDP connection failed: {e}"

    # -- helpers --

    def _get_page(self, page_id: str) -> Page | None:
        return self._pages.get(page_id)

    def _resolve(self, ref: str | None, selector: str | None, page_id: str) -> str | None:
        if ref:
            elements = self._snapshot_elements.get(page_id, {})
            sel = _selector_from_ref(elements, ref)
            if sel:
                return sel
        if selector:
            return selector
        return None

    def _touch(self) -> None:
        self._last_activity = time.monotonic()

    def _cancel_idle(self) -> None:
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
            self._idle_task = None

    async def _idle_watcher(self) -> None:
        """Close browser after idle_timeout seconds of inactivity."""
        try:
            while True:
                await asyncio.sleep(30)
                if time.monotonic() - self._last_activity > self.idle_timeout:
                    logger.info("Browser idle timeout ({}s), closing", self.idle_timeout)
                    await self.stop()
                    return
        except asyncio.CancelledError:
            return

    def _on_console(self, msg: Any) -> None:
        self._console_logs.append({
            "type": msg.type,
            "text": str(msg.text)[:500],
        })
        # Keep last 200
        if len(self._console_logs) > 200:
            self._console_logs = self._console_logs[-200:]

    def _on_request(self, request: Any) -> None:
        self._network_requests.append({
            "method": request.method,
            "url": request.url[:200],
        })
        if len(self._network_requests) > 200:
            self._network_requests = self._network_requests[-200:]

    @staticmethod
    def _find_chrome() -> str | None:
        """Detect installed Chrome/Edge/Chromium executable."""
        candidates: list[str] = []
        if sys.platform == "win32":
            candidates = [
                os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
                os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
            ]
        elif sys.platform == "darwin":
            candidates = [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ]
        else:
            candidates = [
                "/usr/bin/google-chrome",
                "/usr/bin/chromium-browser",
                "/usr/bin/chromium",
                "/snap/bin/chromium",
            ]
        for c in candidates:
            if os.path.isfile(c):
                return c
        return None

    @staticmethod
    def _build_launch_args(cdp_port: int | None) -> list[str]:
        args = []
        if sys.platform == "win32":
            args.extend(["--no-sandbox", "--disable-gpu"])
        if cdp_port:
            args.append(f"--remote-debugging-port={cdp_port}")
        return args


# ---------------------------------------------------------------------------
# Global session registry (one per workspace)
# ---------------------------------------------------------------------------
_sessions: dict[str, BrowserSession] = {}


def _get_session(workspace: Path, idle_timeout: int = 600, proxy: str | None = None) -> BrowserSession:
    """Get or create a BrowserSession for the given workspace."""
    key = str(workspace.resolve())
    if key not in _sessions:
        data_dir = workspace / ".browser-data"
        _sessions[key] = BrowserSession(
            user_data_dir=data_dir,
            idle_timeout=idle_timeout,
            proxy=proxy,
        )
    return _sessions[key]


# ---------------------------------------------------------------------------
# Tool definition
# ---------------------------------------------------------------------------

@tool_parameters(
    tool_parameters_schema(
        action=StringSchema("Action to perform", enum=tuple(_ALL_ACTIONS)),
        page_id=StringSchema("Target tab/page ID (default: 'page_1')", nullable=True),
        url=StringSchema("URL for open/navigate actions", nullable=True),
        ref=StringSchema("Element reference ID from snapshot", nullable=True),
        selector=StringSchema("CSS / Playwright selector", nullable=True),
        element=StringSchema("Natural-language element description (fallback)", nullable=True),
        text=StringSchema("Text to type or fill", nullable=True),
        key=StringSchema("Key to press (e.g. 'Enter', 'Control+a')", nullable=True),
        start_ref=StringSchema("Source element ref for drag", nullable=True),
        end_ref=StringSchema("Target element ref for drag", nullable=True),
        start_selector=StringSchema("Source element selector for drag", nullable=True),
        end_selector=StringSchema("Target element selector for drag", nullable=True),
        values=StringSchema("JSON array of values for select_option", nullable=True),
        slowly=BooleanSchema(description="Type text character by character"),
        headed=BooleanSchema(description="Launch browser in headed mode (visible window)"),
        cdp_port=IntegerSchema(description="Chrome DevTools Protocol debug port", minimum=1, maximum=65535, nullable=True),
        cdp_url=StringSchema("CDP endpoint URL for connect_cdp (e.g. http://localhost:9222)", nullable=True),
        path=StringSchema("File path for screenshot/pdf output", nullable=True),
        full_page=BooleanSchema(description="Capture full-page screenshot"),
        code=StringSchema("JavaScript code for evaluate action", nullable=True),
        level=StringSchema("Filter console messages by level", nullable=True),
        include_static=BooleanSchema(description="Include static assets in network requests"),
        accept=BooleanSchema(description="Accept dialog (true) or dismiss (false)"),
        dialog_text=StringSchema("Text to enter in prompt dialog", nullable=True),
        file_paths=StringSchema("Comma-separated file paths for upload", nullable=True),
        fields=StringSchema("JSON object mapping ref->value for fill_form", nullable=True),
        condition=StringSchema("Wait condition: visible/hidden/attached/detached", enum=("visible", "hidden", "attached", "detached"), nullable=True),
        timeout=IntegerSchema(description="Timeout in milliseconds", minimum=1000, maximum=120000, nullable=True),
        width=IntegerSchema(description="Viewport width for resize", minimum=100, maximum=7680, nullable=True),
        height=IntegerSchema(description="Viewport height for resize", minimum=100, maximum=4320, nullable=True),
        cookies_json=StringSchema("JSON array of cookie objects for cookies_set", nullable=True),
        required=["action"],
    )
)
class BrowserControlTool(Tool):
    """Browser automation tool. Use action parameter to specify the operation.

Actions:
- start: Start browser (headed/True for visible window)
- stop: Stop browser
- open: Open URL in new tab (auto-starts browser if needed)
- navigate: Navigate existing tab to URL
- close: Close a tab
- snapshot: Get interactive element tree with ref IDs
- click: Click element by ref or selector
- type: Type text into element by ref or selector
- hover: Hover over element by ref or selector
- drag: Drag element to another element
- select_option: Select dropdown option by ref or selector
- press_key: Press keyboard key
- screenshot: Take page screenshot
- evaluate: Execute JavaScript
- console_messages: Get console logs
- network_requests: Get network request log
- pdf: Export page as PDF
- handle_dialog: Handle alert/confirm/prompt dialog
- file_upload: Upload files to input element
- fill_form: Fill multiple form fields at once (JSON ref->value)
- tabs: List open tabs (no extra params needed)
- wait_for: Wait for element condition
- resize: Resize viewport
- cookies_get/cookies_set/cookies_clear: Cookie management
- connect_cdp: Connect to running Chrome via CDP URL

Always use snapshot first to get ref IDs, then use ref for subsequent actions.
"""

    def __init__(
        self,
        workspace: Path,
        idle_timeout: int = 600,
        proxy: str | None = None,
    ) -> None:
        self._workspace = workspace
        self._idle_timeout = idle_timeout
        self._proxy = proxy

    @property
    def name(self) -> str:
        return "browser_control"

    @property
    def description(self) -> str:
        return (
            "Browser automation tool (Playwright). "
            "Use action to specify operation. "
            "Actions: start, stop, open, navigate, close, snapshot, click, type, "
            "hover, drag, select_option, press_key, screenshot, evaluate, "
            "console_messages, network_requests, pdf, handle_dialog, file_upload, "
            "fill_form, tabs, wait_for, resize, cookies_get/set/clear, connect_cdp. "
            "Use snapshot first to get ref IDs, then use ref for interactions."
        )

    @property
    def exclusive(self) -> bool:
        return True

    async def execute(self, **kwargs: Any) -> str:
        action: str = kwargs.get("action", "")
        session = _get_session(self._workspace, self._idle_timeout, self._proxy)

        page_id = kwargs.get("page_id", "page_1")

        dispatch: dict[str, Any] = {
            "start": lambda: session.start(
                headed=bool(kwargs.get("headed", False)),
                cdp_port=kwargs.get("cdp_port"),
            ),
            "stop": lambda: session.stop(),
            "open": lambda: session.open(url=kwargs.get("url", ""), page_id=kwargs.get("page_id")),
            "navigate": lambda: session.navigate(url=kwargs.get("url", ""), page_id=page_id),
            "close": lambda: session.close_tab(page_id=page_id),
            "snapshot": lambda: session.snapshot(page_id=page_id),
            "click": lambda: session.click(ref=kwargs.get("ref"), selector=kwargs.get("selector"), page_id=page_id),
            "type": lambda: session.type_text(
                ref=kwargs.get("ref"), selector=kwargs.get("selector"),
                text=kwargs.get("text", ""), slowly=bool(kwargs.get("slowly", False)),
                page_id=page_id,
            ),
            "hover": lambda: session.hover(ref=kwargs.get("ref"), selector=kwargs.get("selector"), page_id=page_id),
            "drag": lambda: session.drag(
                start_ref=kwargs.get("start_ref"), end_ref=kwargs.get("end_ref"),
                start_selector=kwargs.get("start_selector"), end_selector=kwargs.get("end_selector"),
                page_id=page_id,
            ),
            "select_option": lambda: session.select_option(
                ref=kwargs.get("ref"), selector=kwargs.get("selector"),
                values=kwargs.get("values", ""), page_id=page_id,
            ),
            "press_key": lambda: session.press_key(key=kwargs.get("key", ""), page_id=page_id),
            "screenshot": lambda: session.screenshot(
                page_id=page_id, path=kwargs.get("path"), full_page=bool(kwargs.get("full_page", False)),
            ),
            "evaluate": lambda: session.evaluate(
                code=kwargs.get("code", ""), ref=kwargs.get("ref"),
                selector=kwargs.get("selector"), page_id=page_id,
            ),
            "console_messages": lambda: session.console_messages(level=kwargs.get("level"), page_id=page_id),
            "network_requests": lambda: session.network_requests(
                include_static=bool(kwargs.get("include_static", False)), page_id=page_id,
            ),
            "pdf": lambda: session.pdf(path=kwargs.get("path", ""), page_id=page_id),
            "handle_dialog": lambda: session.handle_dialog(
                accept=bool(kwargs.get("accept", True)), text=kwargs.get("dialog_text", ""), page_id=page_id,
            ),
            "file_upload": lambda: session.file_upload(
                ref=kwargs.get("ref"), selector=kwargs.get("selector"),
                file_paths=kwargs.get("file_paths", ""), page_id=page_id,
            ),
            "fill_form": lambda: session.fill_form(fields=kwargs.get("fields", ""), page_id=page_id),
            "tabs": lambda: session.tabs_list(),
            "wait_for": lambda: session.wait_for(
                condition=kwargs.get("condition", "visible"),
                ref=kwargs.get("ref"), selector=kwargs.get("selector"),
                timeout=kwargs.get("timeout", 30000), page_id=page_id,
            ),
            "resize": lambda: session.resize(
                width=kwargs.get("width", 1280), height=kwargs.get("height", 720), page_id=page_id,
            ),
            "cookies_get": lambda: session.cookies_get(page_id=page_id),
            "cookies_set": lambda: session.cookies_set(cookies_json=kwargs.get("cookies_json", ""), page_id=page_id),
            "cookies_clear": lambda: session.cookies_clear(page_id=page_id),
            "connect_cdp": lambda: session.connect_cdp(cdp_url=kwargs.get("cdp_url", "")),
        }

        handler = dispatch.get(action)
        if handler is None:
            valid = ", ".join(sorted(dispatch.keys()))
            return f"Error: Unknown action '{action}'. Valid actions: {valid}"
        try:
            result = await handler()
            return result
        except Exception as e:
            logger.exception("Browser tool error: action={}", action)
            return f"Error: {e}"
