import { describe, expect, it } from "vite-plus/test";

import { detectComposerTrigger, detectIncompleteQuotedComposerPath, serializeComposerFileLink } from "./composerTrigger.ts";
import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

describe("unfinished quoted path queries", () => {
  it.each([
    ['@"需求 文档/', '需求 文档/'],
    ['@"目录/含\\"引号/', '目录/含"引号/'],
    ['@"目录/反\\\\斜杠/', '目录/反\\斜杠/'],
  ])("keeps %j editable and decodes the existing quoted-path escapes", (source, query) => {
    expect(detectComposerTrigger(source, source.length)).toEqual({
      kind: "path", query, rangeStart: 0, rangeEnd: source.length,
    });
    expect(collectComposerInlineTokens(source)).toEqual([]);
    expect(collectComposerInlineTokens(`${source}" `)).toMatchObject([{ type: "mention", value: query }]);
  });

  it("keeps UTF-16 cursor offsets and the surrounding text outside the replacement", () => {
    const prefix = "请检查 👋 ";
    const active = '@"需求 文档/';
    const text = `${prefix}${active} 后续正文`;
    expect(detectIncompleteQuotedComposerPath(text, prefix.length + active.length)).toEqual({
      kind: "path", query: "需求 文档/", rangeStart: prefix.length, rangeEnd: prefix.length + active.length,
    });
  });

  it.each(['@"已闭合"', '@"已闭合" ', '前缀@"不是独立路径/', '@"末尾\\',
    ...["\n", "\r", "\t", "\0", "\u007f", "\u0085", "\u2028", "\u2029"].map((control) => `@"需求${control}文档/`),
  ])("does not continue a closed, invalid or incomplete escape in %j", (text) => {
    expect(detectIncompleteQuotedComposerPath(text, text.length)).toBeNull();
    expect(detectComposerTrigger(text, text.length)).toBeNull();
  });
});

describe("detectComposerTrigger", () => {
  it.each([
    ["Run /tmp/build.sh", "Run /tmp/build.sh".length],
    ["/etc/hosts", "/etc/hosts".length],
    ["Use /etc/hosts now", "Use /et".length],
  ])("keeps the path in %j out of the slash menu", (text, cursor) => {
    expect(detectComposerTrigger(text, cursor)).toBeNull();
  });

  it("keeps a slash in the line-leading model picker query", () => {
    expect(detectComposerTrigger("/model openai/gpt", 17)).toMatchObject({
      kind: "slash-model",
      query: "openai/gpt",
    });
  });

  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "𑿝"])("detects %s skill prefixes and their source range", (prefix) => {
    const text = `Use ${prefix}review`;
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "skill",
      query: "review",
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});
