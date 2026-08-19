export type ScriptTextEdit = {
  contents: string;
  selectionStart: number;
  selectionEnd: number;
};

const INDENT = "  ";

export function toggleScriptLineComments(
  contents: string,
  selectionStart: number,
  selectionEnd: number,
): ScriptTextEdit {
  return editSelectedLines(contents, selectionStart, selectionEnd, (lines) => {
    const nonBlankLines = lines.filter((line) => line.trim().length > 0);
    const uncomment = nonBlankLines.length > 0
      && nonBlankLines.every((line) => /^\s*#/.test(line));
    return lines.map((line) => {
      if (!line.trim()) return line;
      if (uncomment) return line.replace(/^(\s*)# ?/, "$1");
      return line.replace(/^(\s*)(.*)$/, "$1# $2");
    });
  });
}

export function indentScriptLines(
  contents: string,
  selectionStart: number,
  selectionEnd: number,
): ScriptTextEdit {
  if (selectionStart === selectionEnd) {
    return {
      contents: `${contents.slice(0, selectionStart)}${INDENT}${contents.slice(selectionEnd)}`,
      selectionStart: selectionStart + INDENT.length,
      selectionEnd: selectionStart + INDENT.length,
    };
  }
  return editSelectedLines(
    contents,
    selectionStart,
    selectionEnd,
    (lines) => lines.map((line) => `${INDENT}${line}`),
  );
}

export function outdentScriptLines(
  contents: string,
  selectionStart: number,
  selectionEnd: number,
): ScriptTextEdit {
  return editSelectedLines(
    contents,
    selectionStart,
    selectionEnd,
    (lines) => lines.map((line) => line.startsWith("\t")
      ? line.slice(1)
      : line.replace(/^ {1,2}/, "")),
  );
}

function editSelectedLines(
  contents: string,
  selectionStart: number,
  selectionEnd: number,
  edit: (lines: string[]) => string[],
): ScriptTextEdit {
  const boundedStart = Math.max(0, Math.min(selectionStart, contents.length));
  const boundedEnd = Math.max(boundedStart, Math.min(selectionEnd, contents.length));
  const lineStart = contents.lastIndexOf("\n", Math.max(0, boundedStart - 1)) + 1;
  const effectiveEnd = boundedEnd > boundedStart && contents[boundedEnd - 1] === "\n"
    ? boundedEnd - 1
    : boundedEnd;
  const nextLineBreak = contents.indexOf("\n", effectiveEnd);
  const lineEnd = nextLineBreak < 0 ? contents.length : nextLineBreak;
  const replacement = edit(contents.slice(lineStart, lineEnd).split("\n")).join("\n");
  return {
    contents: `${contents.slice(0, lineStart)}${replacement}${contents.slice(lineEnd)}`,
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length,
  };
}
