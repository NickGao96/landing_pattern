import { afterEach, describe, expect, it, vi } from "vitest";

function setNavigatorLanguages(languages: string[], language: string): void {
  Object.defineProperty(window.navigator, "languages", {
    configurable: true,
    value: languages,
  });
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language,
  });
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("store language defaults", () => {
  it("uses Chinese when the browser prefers Chinese", async () => {
    setNavigatorLanguages(["zh-CN", "en-US"], "zh-CN");
    const { resolveDefaultLanguage, useAppStore } = await import("./store");

    expect(resolveDefaultLanguage()).toBe("zh");
    expect(useAppStore.getState().language).toBe("zh");
  });

  it("falls back to English when no supported browser language is preferred", async () => {
    setNavigatorLanguages(["fr-FR"], "fr-FR");
    const { resolveDefaultLanguage, useAppStore } = await import("./store");

    expect(resolveDefaultLanguage()).toBe("en");
    expect(useAppStore.getState().language).toBe("en");
  });
});
