import { WrapText } from "lucide-react";
import { isValidElement, useState, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  CodeBlock,
  CodeBlockCopyButton,
  useIsCodeFenceIncomplete,
  type ExtraProps,
} from "streamdown";

export function MarkdownCode({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  const { t } = useTranslation("chat");
  const [wrap, setWrap] = useState(false);
  const incomplete = useIsCodeFenceIncomplete();
  if (!("data-block" in props)) {
    return (
      <code {...props} className={className} data-streamdown="inline-code">
        {children}
      </code>
    );
  }
  const source =
    (isValidElement<{ children?: ReactNode }>(children) ? children.props.children : children) ?? "";
  if (typeof source !== "string") {
    throw new Error("Markdown code block must contain text");
  }
  const language = /language-([^\s]+)/.exec(className ?? "")?.[1] ?? "";
  return (
    <div className="react-markdown-code" data-wrap={wrap}>
      <CodeBlock code={source} language={language} isIncomplete={incomplete} lineNumbers={false}>
        <button
          type="button"
          data-streamdown="code-block-wrap-button"
          aria-label={t("codeBlock.wrap")}
          aria-pressed={wrap}
          title={t(wrap ? "codeBlock.unwrap" : "codeBlock.wrap")}
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText size={16} aria-hidden="true" />
        </button>
        <CodeBlockCopyButton
          onError={(error) => console.error("[Tinybot chat] code copy failed", error)}
        />
      </CodeBlock>
    </div>
  );
}
