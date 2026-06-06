export const DESKTOP_DESIGN_TOKENS_STYLE_ID = "desktop-design-tokens";

export function installDesktopDesignTokens(targetDocument: Document = document): void {
  if (targetDocument.getElementById(DESKTOP_DESIGN_TOKENS_STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = DESKTOP_DESIGN_TOKENS_STYLE_ID;
  style.setAttribute("id", DESKTOP_DESIGN_TOKENS_STYLE_ID);
  style.textContent = `
    :root {
      --bg: #faf9f5;
      --bg-subtle: #f5f0e8;
      --panel: #faf9f5;
      --panel-strong: #faf9f5;
      --panel-gradient: #faf9f5;
      --border: #e6dfd8;
      --border-subtle: #ebe6df;
      --text: #141413;
      --text-strong: #252523;
      --text-muted: #6c6a64;
      --text-subtle: #8e8b82;
      --accent: #cc785c;
      --accent-hover: #a9583e;
      --accent-soft: rgba(204, 120, 92, 0.12);
      --accent-glow: rgba(204, 120, 92, 0.15);
      --accent-glow-strong: rgba(204, 120, 92, 0.24);
      --danger: #c64545;
      --danger-soft: rgba(198, 69, 69, 0.12);
      --success: #5db872;
      --success-soft: rgba(93, 184, 114, 0.14);
      --warning: #d4a017;
      --warning-soft: rgba(212, 160, 23, 0.14);
      --surface-card: #efe9de;
      --surface-soft: #f5f0e8;
      --surface-cream-strong: #e8e0d2;
      --surface-dark: #181715;
      --surface-dark-elevated: #252320;
      --surface-dark-soft: #1f1e1b;
      --on-primary: #ffffff;
      --on-dark: #faf9f5;
      --on-dark-soft: #a09d96;
      --accent-teal: #5db8a6;
      --accent-amber: #e8a55a;
      --shadow-xs: 0 1px 2px rgba(20, 20, 19, 0.04);
      --shadow-sm: 0 1px 3px rgba(20, 20, 19, 0.08);
      --shadow-md: 0 8px 22px rgba(20, 20, 19, 0.08);
      --shadow-lg: 0 14px 36px rgba(20, 20, 19, 0.10);
      --shadow-xl: 0 22px 54px rgba(20, 20, 19, 0.12);
      --radius-xs: 4px;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-xl: 16px;
      --radius-full: 9999px;
      --transition-fast: 120ms ease;
      --transition-base: 200ms ease;
      --transition-slow: 300ms ease;
      --font-display: "Cormorant Garamond", "Tiempos Headline", Garamond, "Times New Roman", serif;
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-mono: "JetBrains Mono", "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", monospace;
      --primary: var(--accent);
      --primary-hover: var(--accent-hover);
      --primary-active: var(--accent-hover);
      --muted: var(--text-muted);
      --border-soft: var(--border-subtle);
      --focus-ring: var(--accent-glow);
      --semantic-bg: #f7f7f2;
      --semantic-bg-subtle: #eef3f1;
      --semantic-surface: #ffffff;
      --semantic-surface-raised: #f9fbfa;
      --semantic-border: #d8dfdc;
      --semantic-text: #17201d;
      --semantic-text-muted: #66736f;
      --semantic-primary: #2f6f8f;
      --semantic-primary-hover: #255a73;
      --semantic-success: #3f8f62;
      --semantic-warning: #b7791f;
      --semantic-danger: #b54545;
      --semantic-info: #4b6bdb;
      --graph-node-entity: #2f6f8f;
      --graph-node-document: #7b5ea7;
      --graph-node-claim: #3f8f62;
      --graph-node-conflict: #b54545;
      --density-list-row: 36px;
      --density-table-row: 40px;
      --density-toolbar-height: 44px;
      --density-inspector-gap: 12px;
      --density-chat-gap: 14px;
    }

    [data-theme="dark"] {
      --bg: #181715;
      --bg-subtle: #1f1e1b;
      --panel: #1f1e1b;
      --panel-strong: #252320;
      --panel-gradient: #1f1e1b;
      --border: rgba(250, 249, 245, 0.12);
      --border-subtle: rgba(250, 249, 245, 0.08);
      --text: #faf9f5;
      --text-strong: #faf9f5;
      --text-muted: #a09d96;
      --text-subtle: #8e8b82;
      --accent: #cc785c;
      --accent-hover: #e08b6f;
      --accent-soft: rgba(204, 120, 92, 0.16);
      --accent-glow: rgba(204, 120, 92, 0.20);
      --accent-glow-strong: rgba(204, 120, 92, 0.30);
      --danger: #e05b5b;
      --danger-soft: rgba(224, 91, 91, 0.16);
      --success: #5db872;
      --success-soft: rgba(93, 184, 114, 0.16);
      --warning: #e8a55a;
      --warning-soft: rgba(232, 165, 90, 0.16);
      --surface-card: #252320;
      --surface-soft: #1f1e1b;
      --surface-cream-strong: #252320;
      --surface-dark: #141413;
      --surface-dark-elevated: #252320;
      --surface-dark-soft: #1f1e1b;
      --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.26);
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.28);
      --shadow-md: 0 8px 22px rgba(0, 0, 0, 0.30);
      --shadow-lg: 0 14px 36px rgba(0, 0, 0, 0.34);
      --shadow-xl: 0 22px 54px rgba(0, 0, 0, 0.38);
      --semantic-bg: #151918;
      --semantic-bg-subtle: #1d2522;
      --semantic-surface: #202927;
      --semantic-surface-raised: #26312e;
      --semantic-border: rgba(236, 244, 241, 0.14);
      --semantic-text: #edf5f2;
      --semantic-text-muted: #a8b6b1;
      --semantic-primary: #6ca9c4;
      --semantic-primary-hover: #82bad2;
      --semantic-success: #6fbd8d;
      --semantic-warning: #d5a64a;
      --semantic-danger: #e16c6c;
      --semantic-info: #8ea2ff;
    }

    [data-density="compact"] {
      --density-list-row: 30px;
      --density-table-row: 34px;
      --density-toolbar-height: 38px;
      --density-inspector-gap: 8px;
      --density-chat-gap: 10px;
    }

    [data-density="focus"] {
      --density-list-row: 40px;
      --density-table-row: 44px;
      --density-toolbar-height: 48px;
      --density-inspector-gap: 16px;
      --density-chat-gap: 18px;
    }
  `;
  targetDocument.head.append(style);
}
