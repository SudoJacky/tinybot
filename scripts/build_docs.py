#!/usr/bin/env python3
"""
Tinybot Documentation Builder

Builds static HTML documentation from Markdown files.
Usage: uv run python scripts/build_docs.py
"""

import json
import os
import re
import shutil
from html import escape
from pathlib import Path

# Try to import markdown, fallback to basic parsing
try:
    import markdown
    from markdown.extensions.tables import TableExtension
    from markdown.extensions.fenced_code import FencedCodeExtension

    HAS_MARKDOWN = True
except ImportError:
    HAS_MARKDOWN = False

# Configuration
DOCS_DIR = Path(__file__).parent.parent / "docs"
WEBUI_DIR = Path(__file__).parent.parent / "webui"
OUTPUT_DIR = WEBUI_DIR / "docs"  # Output documentation HTML under webui/docs

# Navigation structure with /docs as the landing page
NAV_STRUCTURE = [
    {"id": "docs", "title": "文档首页", "title_en": "Docs Home", "icon": "book"},
    {"id": "quickstart", "title": "快速开始", "title_en": "Quick Start", "icon": "rocket"},
    {"id": "webui", "title": "WebUI 指南", "title_en": "WebUI Guide", "icon": "browser"},
    {"id": "tasks", "title": "任务调度", "title_en": "Task Scheduling", "icon": "dag"},
    {"id": "knowledge", "title": "知识库 RAG", "title_en": "Knowledge RAG", "icon": "brain"},
    {"id": "tools", "title": "工具系统", "title_en": "Tools", "icon": "wrench"},
    {"id": "skills", "title": "技能系统", "title_en": "Skills", "icon": "magic"},
    {"id": "cli", "title": "CLI 命令", "title_en": "CLI Commands", "icon": "terminal"},
    {"id": "providers", "title": "Provider 配置", "title_en": "Providers", "icon": "cloud"},
    {"id": "gateway", "title": "Gateway 配置", "title_en": "Gateway", "icon": "server"},
    {"id": "config", "title": "配置系统", "title_en": "Configuration", "icon": "settings"},
]

# Map markdown file ID to HTML output ID
DOC_ID_MAP = {
    "index": "quickstart",
}


def parse_markdown_basic(content: str) -> str:
    """Basic markdown to HTML conversion without external library."""

    def render_inline(text: str) -> str:
        placeholders: list[str] = []

        def stash_code(match: re.Match[str]) -> str:
            placeholders.append(f"<code>{escape(match.group(1))}</code>")
            return f"\x00CODE{len(placeholders) - 1}\x00"

        text = escape(text)
        text = re.sub(r"`([^`]+)`", stash_code, text)
        text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
        text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text)
        text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
        text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", text)
        for index, value in enumerate(placeholders):
            text = text.replace(f"\x00CODE{index}\x00", value)
        return text

    def is_table_separator(line: str) -> bool:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)

    def split_table_row(line: str) -> list[str]:
        return [cell.strip() for cell in line.strip().strip("|").split("|")]

    def render_table(table_lines: list[str]) -> str:
        header = split_table_row(table_lines[0])
        rows = [split_table_row(line) for line in table_lines[2:]]
        html = ["<table>", "<thead>", "<tr>"]
        html.extend(f"<th>{render_inline(cell)}</th>" for cell in header)
        html.extend(["</tr>", "</thead>", "<tbody>"])
        for row in rows:
            html.append("<tr>")
            html.extend(f"<td>{render_inline(cell)}</td>" for cell in row)
            html.append("</tr>")
        html.extend(["</tbody>", "</table>"])
        return "\n".join(html)

    lines = content.splitlines()
    result: list[str] = []
    paragraph: list[str] = []
    list_type: str | None = None
    code_lang: str | None = None
    code_lines: list[str] = []
    i = 0

    def flush_paragraph() -> None:
        if paragraph:
            result.append(f"<p>{render_inline(' '.join(line.strip() for line in paragraph))}</p>")
            paragraph.clear()

    def close_list() -> None:
        nonlocal list_type
        if list_type:
            result.append(f"</{list_type}>")
            list_type = None

    while i < len(lines):
        line = lines[i]

        if code_lang is not None:
            if line.startswith("```"):
                result.append(
                    f'<pre><code class="language-{escape(code_lang)}">{escape(chr(10).join(code_lines))}</code></pre>'
                )
                code_lang = None
                code_lines = []
            else:
                code_lines.append(line)
            i += 1
            continue

        fence = re.match(r"^```([A-Za-z0-9_-]*)\s*$", line)
        if fence:
            flush_paragraph()
            close_list()
            code_lang = fence.group(1) or ""
            code_lines = []
            i += 1
            continue

        if not line.strip():
            flush_paragraph()
            close_list()
            i += 1
            continue

        if re.fullmatch(r"\s*[-*_]{3,}\s*", line):
            flush_paragraph()
            close_list()
            result.append("<hr>")
            i += 1
            continue

        if i + 1 < len(lines) and "|" in line and is_table_separator(lines[i + 1]):
            flush_paragraph()
            close_list()
            table_lines = [line, lines[i + 1]]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                table_lines.append(lines[i])
                i += 1
            result.append(render_table(table_lines))
            continue

        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)
        if heading:
            flush_paragraph()
            close_list()
            level = len(heading.group(1))
            result.append(f"<h{level}>{render_inline(heading.group(2))}</h{level}>")
            i += 1
            continue

        unordered = re.match(r"^\s*[-*]\s+(.+)$", line)
        ordered = re.match(r"^\s*\d+\.\s+(.+)$", line)
        if unordered or ordered:
            flush_paragraph()
            needed_type = "ul" if unordered else "ol"
            if list_type != needed_type:
                close_list()
                result.append(f"<{needed_type}>")
                list_type = needed_type
            item = (unordered or ordered).group(1)
            result.append(f"<li>{render_inline(item)}</li>")
            i += 1
            continue

        close_list()
        paragraph.append(line)
        i += 1

    flush_paragraph()
    close_list()
    if code_lang is not None:
        result.append(
            f'<pre><code class="language-{escape(code_lang)}">{escape(chr(10).join(code_lines))}</code></pre>'
        )

    return "\n".join(result)


def parse_markdown(content: str) -> str:
    """Parse markdown to HTML."""
    if HAS_MARKDOWN:
        md = markdown.Markdown(
            extensions=[
                TableExtension(),
                FencedCodeExtension(),
                "toc",
            ]
        )
        return md.convert(content)
    else:
        return parse_markdown_basic(content)


def get_icon_svg(icon_name: str) -> str:
    """Get SVG icon by name."""
    icons = {
        "rocket": '<path d="M4.5 16.5c-1.5 1.26-2 5.5-2 5.5s3.5-.5 5.5-2c.5-.5 1-1.5 1-2.5c0-1-.5-2-1-3c-1.5-2-4-3-4-3s-.5 2 0 3"/><path d="M12 12c-2-2-4-4-4-4s1-2 2-3c1-.5 2-1 3-1c1 0 2 .5 3 1c1 1 2 3 2 3s-2 2-4 4"/><path d="M12 12l3-3c2 0 4 0 6 2c-2 2-4 2-6 2l-3 3"/>',
        "browser": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
        "dag": '<circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M5 9v3a3 3 0 0 0 3 3h4"/><path d="M19 9v3a3 3 0 0 1-3 3h-4"/>',
        "brain": '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A6 6 0 0 1 12 21a6 6 0 0 1 9.967-5.517 4 4 0 0 0 .556-6.588 4 4 0 0 0-2.526-5.77A3 3 0 1 0 12 5"/>',
        "wrench": '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2 2 0 0 1-2.83-2.83l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
        "magic": '<path d="m12 3 1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3Z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/>',
        "terminal": '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        "cloud": '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
        "server": '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
        "book": '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
        "chevron": '<polyline points="9 18 15 12 9 6"/>',
        "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    }
    svg = icons.get(icon_name, icons["book"])
    return f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{svg}</svg>'


def get_html_id(md_id: str) -> str:
    """Map markdown file ID to HTML output ID."""
    return DOC_ID_MAP.get(md_id, md_id)


def get_doc_href(doc_id: str) -> str:
    """Return the public URL for a documentation page."""
    html_id = get_html_id(doc_id)
    return "/docs" if html_id == "docs" else f"/docs/{html_id}"


def normalize_doc_links(content_html: str) -> str:
    """Rewrite local documentation links to the public /docs URL namespace."""
    valid_ids = {get_html_id(item["id"]) for item in NAV_STRUCTURE}

    def replace_link(match: re.Match[str]) -> str:
        target = match.group(1)
        page = target.rsplit(".", 1)[0]
        if page in valid_ids:
            return f'href="{"/docs" if page == "docs" else f"/docs/{page}"}"'
        return match.group(0)

    return re.sub(r'href="([A-Za-z0-9_-]+\.(?:html|md))"', replace_link, content_html)


def generate_html(doc_id: str, title: str, title_en: str, content_html: str, all_docs: dict) -> str:
    """Generate HTML page for a document."""
    content_html = normalize_doc_links(content_html)

    # Generate navigation
    nav_html = '<nav class="docs-nav">'
    for item in NAV_STRUCTURE:
        html_id = get_html_id(item["id"])
        is_active = html_id == doc_id
        active_class = "nav-item active" if is_active else "nav-item"
        nav_html += f'''
        <a href="{get_doc_href(item["id"])}" class="{active_class}" data-i18n-title="docs.nav.{item["id"]}">
            <span class="nav-icon">{get_icon_svg(item["icon"])}</span>
            <span class="nav-title" data-i18n="docs.nav.{item["id"]}">{item["title"]}</span>
        </a>'''
    nav_html += "</nav>"

    # Generate table of contents from content
    toc_html = '<nav class="docs-toc">'
    toc_html += '<h4 data-i18n="docs.onThisPage">本页内容</h4>'
    # Extract headers from content
    headers = re.findall(r"<h([2-3])>([^<]+)</h[2-3]>", content_html)
    for level, text in headers:
        indent = "toc-h3" if level == "3" else "toc-h2"
        slug = re.sub(r"[^\w]+", "-", text.lower()).strip("-")
        toc_html += f'<a href="#{slug}" class="toc-item {indent}">{text}</a>'
    toc_html += "</nav>"

    # Add IDs to headers for TOC links
    for level, text in headers:
        slug = re.sub(r"[^\w]+", "-", text.lower()).strip("-")
        content_html = content_html.replace(f"<h{level}>{text}</h{level}>", f'<h{level} id="{slug}">{text}</h{level}>')

    # JavaScript code (not in f-string, use string concatenation)
    js_code = """
    <script>
    // Theme toggle
    function initTheme() {
      const savedTheme = localStorage.getItem("tinybot-theme") || "light";
      document.documentElement.setAttribute("data-theme", savedTheme);
    }

    function toggleTheme() {
      const currentTheme = document.documentElement.getAttribute("data-theme");
      const newTheme = currentTheme === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", newTheme);
      localStorage.setItem("tinybot-theme", newTheme);
    }

    // Language toggle
    function updateLanguageButton() {
      const lang = getLanguage();
      document.getElementById("language-toggle").textContent = lang === "zh" ? "EN" : "中文";
    }

    // Initialize
    initTheme();
    updateLanguageButton();

    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    document.getElementById("language-toggle").addEventListener("click", () => {
      const newLang = getLanguage() === "zh" ? "en" : "zh";
      setLanguage(newLang);
      updateLanguageButton();
    });

    // Smooth scroll for TOC links
    document.querySelectorAll('.toc-item').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.querySelector(link.getAttribute('href'));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  </script>"""

    # Generate page HTML
    html = f"""<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} - Tinybot Docs</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/assets/styles.css">
  <link rel="stylesheet" href="/assets/docs-styles.css">
  <script src="/assets/i18n.js"></script>
</head>
<body>
  <div class="docs-shell">
    <!-- Header -->
    <header class="docs-header">
      <a href="/" class="docs-brand">
        <div class="brand-mark">T</div>
        <div>
          <h1 class="docs-title">Tinybot</h1>
          <p class="docs-subtitle">Documentation</p>
        </div>
      </a>
      <div class="docs-actions">
        <button id="language-toggle" class="button" type="button">EN</button>
        <button id="theme-toggle" class="theme-toggle" type="button">
          <svg class="sun-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg class="moon-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <a href="/" class="docs-back-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          <span data-i18n="docs.backToChat">返回聊天</span>
        </a>
      </div>
    </header>

    <!-- Main Layout -->
    <div class="docs-layout">
      <!-- Left Navigation -->
      {nav_html}

      <!-- Content Area -->
      <main class="docs-content">
        <article class="docs-article">
          <header class="article-header">
            <h1 data-i18n="docs.pages.{doc_id}">{title}</h1>
          </header>
          <div class="article-body">
            {content_html}
          </div>
        </article>
      </main>

      <!-- Right Table of Contents -->
      {toc_html}
    </div>
  </div>
{js_code}
</body>
</html>"""

    return html


def build_docs():
    """Build all documentation HTML files."""
    print("Building Tinybot documentation...")

    # Read all markdown files
    all_docs = {}
    for nav_item in NAV_STRUCTURE:
        md_id = nav_item["id"]
        if md_id == "docs":
            print("  Skipped: docs landing page is maintained at webui/docs/index.html")
            continue
        md_path = DOCS_DIR / f"{md_id}.md"
        if md_path.exists():
            content = md_path.read_text(encoding="utf-8")
            all_docs[md_id] = parse_markdown(content)
            print(f"  Parsed: {md_id}.md")
        else:
            print(f"  Warning: {md_path} not found")

    # Generate HTML for each document
    for nav_item in NAV_STRUCTURE:
        md_id = nav_item["id"]
        html_id = get_html_id(md_id)
        if md_id in all_docs:
            html = generate_html(
                doc_id=html_id,
                title=nav_item["title"],
                title_en=nav_item["title_en"],
                content_html=all_docs[md_id],
                all_docs=all_docs,
            )
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            output_name = "index.html" if html_id == "docs" else f"{html_id}.html"
            output_path = OUTPUT_DIR / output_name
            output_path.write_text(html, encoding="utf-8")
            print(f"  Generated: {output_path}")

    print("Done!")


if __name__ == "__main__":
    build_docs()
