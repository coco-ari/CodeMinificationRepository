import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import "../index.css";
vi.mock(import("../autoops/capabilities"), async (original) => ({ ...(await original()), isAutoOpsHosted: () => true }));
import ChatMarkdown from "./ChatMarkdown";
import { getSyntaxHighlighterPromise, PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

it("uses the official JS engine for native code blocks without compiling WebAssembly", async () => {
  const instantiate = vi.spyOn(WebAssembly, "instantiate").mockRejectedValue(new Error("WASM blocked by host CSP"));
  const compile = vi.spyOn(WebAssembly, "compile").mockRejectedValue(new Error("WASM blocked by host CSP"));
  try {
    expect(PREFERRED_HIGHLIGHTER).toBe("shiki-js");
    const fixtures = { typescript: "const answer: number = 42;", json: '{"中文":"测试","ready":true}', bash: 'printf "%s\\n" "hello"', python: 'def hello():\n    return "你好"' };
    for (const [language, code] of Object.entries(fixtures)) {
      await getSyntaxHighlighterPromise(language);
      await using screen = await render(<ChatMarkdown cwd={undefined} text={`\`\`\`${language}\n${code}\n\`\`\``} />);
      await vi.waitFor(() => {
        expect(screen.container.querySelector(".chat-markdown-shiki")).not.toBeNull();
        expect(screen.container.querySelector<HTMLElement>(".chat-markdown-shiki .line span")?.style.color).toBeTruthy();
        expect(screen.container.textContent).toContain(code.split("\n")[0]);
      });
    }
    expect(instantiate).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  } finally { instantiate.mockRestore(); compile.mockRestore(); }
});
