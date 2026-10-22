// Adapted from OpenChamber, MIT License.
// Copyright (c) 2025 Bohdan Triapitsyn.
// Source: openchamber/openchamber@6491f51dbcf05d1e3f7f823049f5f097c96c234b
// packages/ui/src/components/chat/lib/scroll/followScroll.ts
// The application owns its animation; these rules retain the upstream end
// tolerance and distinguish a follow movement from the reader's movement.

export const resolveFollowGlideTarget = (end, scroll) =>
  end - scroll <= 1 ? null : Math.max(0, end)

export const AUTOMATIC_MOVEMENT_MAX_MS = 1000

export const isPositionHeldByFollow = (following, movement, scrollTop, now) =>
  following &&
  movement !== null &&
  now - movement.issuedAt < AUTOMATIC_MOVEMENT_MAX_MS &&
  scrollTop >= Math.min(movement.from, movement.target) - 1 &&
  scrollTop <= Math.max(movement.from, movement.target) + 1
