// Extracted unchanged from OpenChamber FileTreeRowParts.tsx and fileTreeRow.ts.
// Commit 6491f51dbcf05d1e3f7f823049f5f097c96c234b (MIT).
// Copyright (c) 2025 Bohdan Triapitsyn. License: /third-party/agent-demo-streaming-NOTICES.txt
import React from 'react'
// Geometry and row states shared by every file tree; the drawn parts live in
// FileTreeRowParts.tsx.

export const FILE_TREE_INDENT_PX = 12
export const FILE_TREE_BASE_PADDING_PX = 8

/** `basePaddingPx` lets a tree sitting under a differently inset header line up with it. */
export const fileTreeRowPaddingLeft = (
  depth: number,
  basePaddingPx = FILE_TREE_BASE_PADDING_PX,
): string => `${basePaddingPx + depth * FILE_TREE_INDENT_PX}px`

export const FileTreeIndentGuides: React.FC<{ depth: number }> = ({ depth }) => (
  <>
    {Array.from({ length: depth }, (_, level) => (
      <span
        key={level}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-px bg-border/50"
        style={{
          insetInlineStart: `${FILE_TREE_BASE_PADDING_PX + level * FILE_TREE_INDENT_PX + 7}px`,
        }}
      />
    ))}
  </>
)
