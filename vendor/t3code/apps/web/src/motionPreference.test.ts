import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsPatch, ClientSettingsSchema } from "@t3tools/contracts/settings";
import { isMotionReduced, resolveReducedMotion, setMotionPreference, subscribeToMotionPreference } from "./motionPreference";

afterEach(() => {
  setMotionPreference("system");
  vi.unstubAllGlobals();
});

describe("motion preference", () => {
  it.each([
    ["system", false, false], ["system", true, true],
    ["on", false, false], ["on", true, false],
    ["off", false, true], ["off", true, true],
  ] as const)("resolves %s with system reduction %s", (mode, system, expected) => {
    expect(resolveReducedMotion(mode, system)).toBe(expected);
  });

  it("defaults existing preferences to system and rejects invalid saved modes", () => {
    expect(Schema.decodeSync(ClientSettingsSchema)({}).motionPreference).toBe("system");
    expect(Schema.decodeSync(ClientSettingsPatch)({ motionPreference: "on" })).toEqual({ motionPreference: "on" });
    expect(() => Schema.decodeUnknownSync(ClientSettingsPatch)({ motionPreference: "sometimes" })).toThrow();
  });

  it("updates CSS and subscribers when either the app choice or system changes", () => {
    const media = Object.assign(new EventTarget(), { matches: true });
    const root = { dataset: {} as Record<string, string> };
    vi.stubGlobal("window", { matchMedia: () => media });
    vi.stubGlobal("document", { documentElement: root });
    const listener = vi.fn();
    const unsubscribe = subscribeToMotionPreference(listener);
    try {
      expect(isMotionReduced()).toBe(true);
      expect(root.dataset.reducedMotion).toBe("true");
      setMotionPreference("on");
      expect(isMotionReduced()).toBe(false);
      expect(root.dataset).toMatchObject({ motionPreference: "on", reducedMotion: "false" });
      media.matches = false;
      media.dispatchEvent(new Event("change"));
      setMotionPreference("off");
      expect(isMotionReduced()).toBe(true);
      setMotionPreference("system");
      expect(isMotionReduced()).toBe(false);
      media.matches = true;
      media.dispatchEvent(new Event("change"));
      expect(root.dataset.reducedMotion).toBe("true");
      expect(listener).toHaveBeenCalledTimes(6);
    } finally { unsubscribe(); }
    listener.mockClear();
    media.dispatchEvent(new Event("change"));
    expect(listener).not.toHaveBeenCalled();
  });
});
