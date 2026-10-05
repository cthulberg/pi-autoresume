import { describe, expect, test } from "bun:test";
import { formatClock, formatDuration, renderTemplate } from "../src/format.ts";

describe("formatClock", () => {
  test("renders zero-padded local HH:MM", () => {
    expect(formatClock(new Date(2026, 0, 5, 14, 5, 0).getTime())).toBe("14:05");
    expect(formatClock(new Date(2026, 0, 5, 9, 7, 0).getTime())).toBe("09:07");
    expect(formatClock(new Date(2026, 0, 5, 0, 0, 0).getTime())).toBe("00:00");
  });
});

describe("formatDuration", () => {
  test("prints the two largest units", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(300_000)).toBe("5m");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d 3h");
    expect(formatDuration(999)).toBe("0s");
  });
});

describe("renderTemplate", () => {
  test("replaces known placeholders and leaves unknown ones verbatim", () => {
    expect(renderTemplate("◦ resume {reset_abs} · {provider}", { reset_abs: "14:05", provider: "openai-codex" }))
      .toBe("◦ resume 14:05 · openai-codex");
    expect(renderTemplate("a {x} b {y} c {x}", { x: "1" })).toBe("a 1 b {y} c 1");
    expect(renderTemplate("no placeholders", {})).toBe("no placeholders");
  });
});
