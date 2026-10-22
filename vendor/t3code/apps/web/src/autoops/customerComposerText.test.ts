import { describe, expect, it } from "vite-plus/test";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { customerComposerText } from "./customerComposerText";

describe("customer clipboard boundary", () => {
  it("keeps visible labels but drops every platform context identity", () => {
    const text =
      "检查 [发布资料](t3-context://v1/file/file_1) 与 ![截图](t3-context://v1/image/image_2)，参考 [旧对话](t3-context://v1/thread/thread_3)";
    const result = customerComposerText(text);
    expect(result).toBe("检查 发布资料 与 截图，参考 旧对话");
    expect(collectComposerContextReferences(result)).toEqual([]);
  });

  it("keeps local skills, ordinary paths, code and external links verbatim", () => {
    const text =
      "$review 检查 @src/index.ts\n```ts\n@decorator()\nconst value = '$review';\n```\n[文档](https://example.com/docs)";
    expect(customerComposerText(text)).toBe(text);
  });

  it("handles context-only paste without an attachment record or platform import", () => {
    expect(customerComposerText("[终端片段](t3-context://v1/terminal/terminal_1)")).toBe(
      "终端片段",
    );
    expect(customerComposerText("[代码批注](t3-context://v1/review-comment/review_1)")).toBe(
      "代码批注",
    );
  });
});
