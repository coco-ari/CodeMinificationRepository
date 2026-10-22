import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";
import { isAutoOpsHosted } from "../autoops/capabilities";

/**
 * AutoOps keeps its host CSP unchanged and selects Pierre/Shiki's supported JS
 * engine. Standalone retains upstream Oniguruma. Both use the same grammar,
 * theme, incremental rendering and cache pipeline; every singleton caller must
 * pass this choice. Pathological JS regex input remains an engine limitation.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = isAutoOpsHosted() ? "shiki-js" : "shiki-wasm";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(language);
      throw error;
    }
    return getSyntaxHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}
