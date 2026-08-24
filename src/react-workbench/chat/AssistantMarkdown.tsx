import { openUrl } from "@tauri-apps/plugin-opener";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { FileText, Globe2, Mail } from "lucide-react";
import { memo, type ComponentProps, useMemo } from "react";
import {
  Streamdown,
  type Components,
  type ControlsConfig,
  defaultRemarkPlugins,
  type LinkSafetyConfig,
  type PluginConfig,
  type UrlTransform,
} from "streamdown";
import "streamdown/styles.css";
import { isAssistantFileHref, type AssistantFileLink } from "./assistantFileLinks";

const ASSISTANT_MARKDOWN_CONTROLS = {
  code: { copy: true, download: false },
  mermaid: false,
  table: false,
} satisfies ControlsConfig;

const ASSISTANT_MARKDOWN_LINK_SAFETY = {
  enabled: false,
} satisfies LinkSafetyConfig;

const ASSISTANT_MARKDOWN_PLUGINS = {
  cjk,
  code,
} satisfies PluginConfig;

const DISALLOWED_ASSISTANT_ELEMENTS = ["img"];
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const ASSISTANT_FILE_LINK_ORIGIN = "https://tinybot.local";
const ASSISTANT_FILE_LINK_PATH = "/artifact-file";

type AssistantMarkdownLinkKind = "email" | "file" | "github" | "web";

const ASSISTANT_MARKDOWN_LINK_ICON_PROPS = {
  "aria-hidden": true,
  className: "react-message-markdown__link-icon",
  height: 14,
  width: 14,
} as const;

function assistantMarkdownLinkKind(href: string): AssistantMarkdownLinkKind {
  if (decodeAssistantFileLink(href)) {
    return "file";
  }
  const url = new URL(href);
  if (url.protocol === "mailto:") {
    return "email";
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com") ? "github" : "web";
}

function AssistantMarkdownLinkIcon({ kind }: { kind: AssistantMarkdownLinkKind }) {
  if (kind === "github") {
    return (
      <svg {...ASSISTANT_MARKDOWN_LINK_ICON_PROPS} data-link-icon="github" focusable="false" viewBox="0 0 16 16">
        <path fill="currentColor" d="M8 0a8.16 8.16 0 0 0-2.53 15.84c.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.51-2.23.49-2.7-.96-2.7-.96-.36-.94-.89-1.19-.89-1.19-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.71 1.23 1.87.88 2.33.67.07-.52.28-.88.51-1.08-1.78-.21-3.65-.91-3.65-4.02 0-.89.31-1.61.82-2.18-.08-.2-.36-1.03.08-2.15 0 0 .67-.22 2.2.83A7.48 7.48 0 0 1 8 3.98c.68 0 1.36.09 2 .27 1.53-1.05 2.2-.83 2.2-.83.44 1.12.16 1.95.08 2.15.51.57.82 1.29.82 2.18 0 3.12-1.87 3.8-3.66 4.01.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .22.15.47.55.39A8.16 8.16 0 0 0 8 0Z" />
      </svg>
    );
  }
  if (kind === "file") {
    return <FileText {...ASSISTANT_MARKDOWN_LINK_ICON_PROPS} data-link-icon="file" />;
  }
  const LinkIcon = kind === "email" ? Mail : Globe2;
  return <LinkIcon {...ASSISTANT_MARKDOWN_LINK_ICON_PROPS} data-link-icon={kind} />;
}

const transformAssistantMarkdownUrl: UrlTransform = (url, key) => {
  if (key === "src") {
    return null;
  }
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

async function openAssistantMarkdownUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("[Tinybot chat] assistant link open failed", { error, url });
  }
}

function AssistantMarkdownLink({
  children,
  href,
  node: _node,
  onClick: _onClick,
  onOpenFileLink,
  target,
  ...props
}: ComponentProps<"a"> & { node?: unknown; onOpenFileLink?: (link: AssistantFileLink) => void }) {
  if (!href) {
    return <span>{children}</span>;
  }
  const linkKind = assistantMarkdownLinkKind(href);
  const fileHref = linkKind === "file" ? decodeAssistantFileLink(href) : undefined;
  if (linkKind === "file" && !onOpenFileLink) {
    return <span>{children}</span>;
  }
  return (
    <a
      {...props}
      data-link-kind={linkKind}
      data-streamdown="link"
      href={linkKind === "file" ? "#" : href}
      rel="noreferrer noopener"
      target={linkKind === "file" ? undefined : target}
      onClick={(event) => {
        event.preventDefault();
        if (fileHref) {
          onOpenFileLink?.({ href: fileHref });
          return;
        }
        void openAssistantMarkdownUrl(href);
      }}
    >
      <AssistantMarkdownLinkIcon kind={linkKind} />
      <span className="react-message-markdown__link-label">{children}</span>
    </a>
  );
}

function AssistantMarkdownStrong({ node: _node, ...props }: ComponentProps<"strong"> & { node?: unknown }) {
  return <strong data-streamdown="strong" {...props} />;
}

type AssistantMarkdownNode = {
  children?: AssistantMarkdownNode[];
  type?: string;
  url?: string;
};

function remarkAssistantFileLinks() {
  return (tree: AssistantMarkdownNode) => {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === "link" && node.url && isAssistantFileHref(node.url)) {
        node.url = encodeAssistantFileLink(node.url);
      }
      if (node.children) {
        pending.push(...node.children);
      }
    }
  };
}

const ASSISTANT_MARKDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkAssistantFileLinks];

function encodeAssistantFileLink(href: string): string {
  return `${ASSISTANT_FILE_LINK_ORIGIN}${ASSISTANT_FILE_LINK_PATH}?href=${encodeURIComponent(href)}`;
}

function decodeAssistantFileLink(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.origin !== ASSISTANT_FILE_LINK_ORIGIN || url.pathname !== ASSISTANT_FILE_LINK_PATH) {
      return undefined;
    }
    return url.searchParams.get("href") || undefined;
  } catch {
    return undefined;
  }
}

export const AssistantMarkdown = memo(function AssistantMarkdown({
  onOpenFileLink,
  streaming,
  text,
}: {
  onOpenFileLink?: (link: AssistantFileLink) => void;
  streaming: boolean;
  text: string;
}) {
  const components = useMemo(() => ({
    a: (props: ComponentProps<typeof AssistantMarkdownLink>) => (
      <AssistantMarkdownLink {...props} onOpenFileLink={onOpenFileLink} />
    ),
    strong: AssistantMarkdownStrong,
  } satisfies Components), [onOpenFileLink]);
  if (!text.trim()) {
    return null;
  }
  return (
    <Streamdown
      animated={false}
      className="react-message-markdown"
      components={components}
      controls={ASSISTANT_MARKDOWN_CONTROLS}
      disallowedElements={DISALLOWED_ASSISTANT_ELEMENTS}
      isAnimating={false}
      key={streaming ? "streaming" : "complete"}
      lineNumbers={false}
      linkSafety={ASSISTANT_MARKDOWN_LINK_SAFETY}
      mode="streaming"
      plugins={ASSISTANT_MARKDOWN_PLUGINS}
      remarkPlugins={ASSISTANT_MARKDOWN_REMARK_PLUGINS}
      skipHtml
      unwrapDisallowed
      urlTransform={transformAssistantMarkdownUrl}
    >
      {text}
    </Streamdown>
  );
});
