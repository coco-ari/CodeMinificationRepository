import { useSyncExternalStore } from "react";
import { isMotionReduced, subscribeToMotionPreference } from "../motionPreference";

const serverSnapshot = () => false;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToMotionPreference, isMotionReduced, serverSnapshot);
}
