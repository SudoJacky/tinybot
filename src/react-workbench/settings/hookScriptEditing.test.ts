import { describe, expect, test } from "vitest";
import {
  indentScriptLines,
  outdentScriptLines,
  toggleScriptLineComments,
} from "./hookScriptEditing";

describe("hook script editing", () => {
  test("comments and uncomments every selected shell line", () => {
    const source = "$request = Get-Content\n  $response = @{}\n$response";
    const commented = toggleScriptLineComments(source, 0, source.length);
    expect(commented.contents).toBe("# $request = Get-Content\n  # $response = @{}\n# $response");
    expect(toggleScriptLineComments(
      commented.contents,
      commented.selectionStart,
      commented.selectionEnd,
    ).contents).toBe(source);
  });

  test("inserts, indents, and outdents with code-editor tab semantics", () => {
    expect(indentScriptLines("echo ok", 4, 4)).toEqual({
      contents: "echo   ok",
      selectionStart: 6,
      selectionEnd: 6,
    });
    const indented = indentScriptLines("one\ntwo", 0, 7);
    expect(indented.contents).toBe("  one\n  two");
    expect(outdentScriptLines(
      indented.contents,
      indented.selectionStart,
      indented.selectionEnd,
    ).contents).toBe("one\ntwo");
  });
});
