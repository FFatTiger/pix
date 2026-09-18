import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useTheme } from "./useTheme";
import { resolveTheme } from "@/lib/theme";

/**
 * Focused useTheme tests: prove the theme preference owner initializes from
 * the persisted `pi-theme-mode`, applies the html.dark class + color-scheme on
 * mount and on change, persists on set, and resolves the effective theme for
 * the "system" mode via matchMedia.
 */

function ThemeProbe() {
  const { themeMode, resolvedTheme, setThemeMode } = useTheme();
  return (
    <div>
      <span data-testid="mode">{themeMode}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={() => setThemeMode("light")}>set-light</button>
      <button onClick={() => setThemeMode("dark")}>set-dark</button>
      <button onClick={() => setThemeMode("system")}>set-system</button>
    </div>
  );
}

const htmlHasDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
  // Default jsdom system preference: no dark match.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-color-scheme: dark") ? false : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useTheme — theme preference owner", () => {
  it("defaults to dark and applies html.dark on mount", () => {
    render(<ThemeProbe />);
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(htmlHasDark()).toBe(true);
  });

  it("initializes from a persisted light preference and removes html.dark", () => {
    localStorage.setItem("pi-theme-mode", "light");
    render(<ThemeProbe />);
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
    expect(htmlHasDark()).toBe(false);
  });

  it("setThemeMode updates state, persists pi-theme-mode, and applies the class", () => {
    render(<ThemeProbe />);
    fireEvent.click(screen.getByText("set-light"));
    expect(screen.getByTestId("mode").textContent).toBe("light");
    expect(localStorage.getItem("pi-theme-mode")).toBe("light");
    expect(htmlHasDark()).toBe(false);

    fireEvent.click(screen.getByText("set-dark"));
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    expect(localStorage.getItem("pi-theme-mode")).toBe("dark");
    expect(htmlHasDark()).toBe(true);
  });

  it("resolves system mode to the matchMedia preference", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-color-scheme: dark") ? true : true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    localStorage.setItem("pi-theme-mode", "system");
    render(<ThemeProbe />);
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(htmlHasDark()).toBe(true);
  });

  it("resolveTheme honors explicit modes and falls back to dark without matchMedia", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });
});
