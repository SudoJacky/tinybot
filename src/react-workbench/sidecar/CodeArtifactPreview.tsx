import { code } from "@streamdown/code";
import { memo, useMemo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { MarkdownCode } from "../chat/MarkdownCode";

const plugins = { code };

export const CodeArtifactPreview = memo(function CodeArtifactPreview({ text, language }: {
  text: string;
  language: string;
}) {
  // Feed the file source directly to the shared code block: Markdown parsing
  // adds a final newline and normalizes line endings, which must not affect copy.
  const components = useMemo(() => ({
    code: (props: ComponentProps<typeof MarkdownCode>) => <MarkdownCode {...props}>{text}</MarkdownCode>,
  }), [text]);
  const fencedSource = useMemo(() => {
    // Source files can contain Markdown fences (e.g. template strings). A longer
    // delimiter keeps all file contents literal, including HTML and links.
    let fenceLength = 3;
    for (const match of text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
    const fence = "`".repeat(fenceLength);
    return `${fence}${language}\n${text}\n${fence}`;
  }, [text, language]);
  return (
    <Streamdown className="react-message-markdown" components={components} plugins={plugins}
      mode="static" lineNumbers={false} skipHtml>
      {fencedSource}
    </Streamdown>
  );
});
