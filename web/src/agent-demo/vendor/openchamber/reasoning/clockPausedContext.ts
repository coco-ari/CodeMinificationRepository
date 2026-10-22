// OpenChamber 6491f51dbcf05d1e3f7f823049f5f097c96c234b (MIT).
// Copyright (c) 2025 Bohdan Triapitsyn; see /third-party/agent-demo-streaming-NOTICES.txt.
import React from 'react'

/**
 * True inside a surface that stays mounted while the user cannot see it (a
 * closed side panel kept at opacity 0, a row hidden with `invisible`). Every
 * indicator on the shared clock (`useDurationTicker.ts`) stands still there and
 * catches up when shown again. Set it with `PauseClock`.
 */
export const ClockPausedContext = React.createContext(false)
