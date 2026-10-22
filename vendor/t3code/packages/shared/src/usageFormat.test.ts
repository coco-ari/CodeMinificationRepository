// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatPercent,
  formatRelativeHourShort,
  makeWindow,
} from "./usageFormat.ts";

describe("formatPercent", () => {
  it("distinguishes a small positive share from zero", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
    expect(formatPercent(0.0009)).toBe("<0.1%");
    expect(formatPercent(0.001)).toBe("0.1%");
    expect(formatPercent(0.023)).toBe("2.3%");
    expect(formatPercent(0.00004, 2)).toBe("<0.01%");
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("zh-CN", { timeZone: zone, hour: "numeric", hour12: true }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("uses the current system zone when no zone is supplied", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("下午12时");
      vi.stubEnv("TZ", "America/New_York");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("上午8时");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("上午12时");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("下午12时");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("8月11日 下午5时");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("GMT-4 上午1时");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("GMT-5 上午1时");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "GMT-4 01:00",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "GMT-5 01:00",
    );
  });

  it.each([
    [true, "下午2时", "上午12时"],
    [false, "14:00", "00:00"],
  ])("formats hourly usage labels with hour12=%s", (hour12, afternoon, midnight) => {
    const instant = "2026-08-11T14:37:00.000Z";

    expect(formatHourShort(instant, "UTC", hour12)).toBe(afternoon);
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC", hour12)).toBe(midnight);
    expect(formatDateTimeShort(instant, "UTC", hour12)).toBe(`8月11日 ${afternoon}`);
    expect(formatRelativeHourShort(instant, instant, "UTC", hour12)).toBe(`今天 ${afternoon}`);
    expect(formatRelativeHourShort(instant, "2026-08-12T15:37:00.000Z", "UTC", hour12)).toBe(
      `昨天 ${afternoon}`,
    );
    expect(formatRelativeHourShort(instant, "2026-08-14T15:37:00.000Z", "UTC", hour12)).toBe(
      `8月11日 ${afternoon}`,
    );
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "昨天 下午5时",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "今天 下午2时",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("昨天 下午6时");
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
