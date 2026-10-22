import type { MotionPreference } from "@t3tools/contracts/settings";

const query = "(prefers-reduced-motion: reduce)";
let preference: MotionPreference = "system";
let media: MediaQueryList | null = null;
const listeners = new Set<() => void>();

export function resolveReducedMotion(mode: MotionPreference, systemReduced: boolean): boolean {
  return mode === "off" || (mode === "system" && systemReduced);
}

export function isMotionReduced(view?: Pick<Window, "matchMedia"> | null): boolean {
  const systemReduced = view
    ? view.matchMedia?.(query).matches ?? false
    : media?.matches ?? (typeof window !== "undefined" ? window.matchMedia?.(query).matches ?? false : false);
  return resolveReducedMotion(preference, systemReduced);
}

function emitChange() {
  // CSS and imperative animations must resolve the same preference. Keeping
  // this on the document also covers portalled menus and inherited shadow styles.
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.motionPreference = preference;
    document.documentElement.dataset.reducedMotion = String(isMotionReduced());
  }
  for (const listener of listeners) listener();
}

export function setMotionPreference(mode: MotionPreference): void {
  preference = mode;
  emitChange();
}

export function subscribeToMotionPreference(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    media = window.matchMedia?.(query) ?? null;
    media?.addEventListener("change", emitChange);
  }
  listeners.add(listener);
  emitChange();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media?.removeEventListener("change", emitChange);
      media = null;
    }
  };
}
