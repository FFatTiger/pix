import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { PwaRegistration, resolvePwaSurfaceState } from "./PwaRegistration";

describe("resolvePwaSurfaceState", () => {
  it("keeps insecure HTTP origins from registering", () => {
    expect(resolvePwaSurfaceState({ secureContext: false, serviceWorker: true, production: true })).toBe("insecure-origin");
  });

  it("stays web-only in development or without service workers", () => {
    expect(resolvePwaSurfaceState({ secureContext: true, serviceWorker: true, production: false })).toBe("web-only");
    expect(resolvePwaSurfaceState({ secureContext: true, serviceWorker: false, production: true })).toBe("web-only");
  });

  it("only registers in a secure production context", () => {
    expect(resolvePwaSurfaceState({ secureContext: true, serviceWorker: true, production: true })).toBe("ready-to-register");
  });
});

describe("PwaRegistration", () => {
  it("does not call serviceWorker.register on an insecure origin", () => {
    const register = vi.fn();
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    render(<I18nProvider><PwaRegistration /></I18nProvider>);
    expect(screen.getByRole("status").textContent).toBe("This origin is not a secure context, so app install stays unavailable.");
    expect(document.querySelector("[data-pwa-state]")?.getAttribute("data-pwa-state")).toBe("insecure-origin");
    expect(register).not.toHaveBeenCalled();
    cleanup();
  });
});
