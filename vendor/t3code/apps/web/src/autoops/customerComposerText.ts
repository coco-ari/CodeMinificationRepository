import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/** Customer conversations carry plain text and local skill mentions, never platform context. */
export function customerComposerText(text: string): string {
  return replaceComposerContextReferences(text, (reference) => reference.label);
}
