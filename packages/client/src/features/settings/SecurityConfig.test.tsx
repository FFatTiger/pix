import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { SecurityConfig, describeGatePasswordError } from "./SecurityConfig";
import { HttpError } from "@/api/http-client";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function mount(fetchImpl: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <I18nProvider><SecurityConfig /></I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function fillForm(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText("Current key"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New key"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Confirm new key"), { target: { value: confirm } });
}

describe("SecurityConfig — access key", () => {
  it("changes the key through the typed mutation and clears the form on success", async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/gate/status")) {
        return json({ required: true, authenticated: true, mode: "local", status: "enabled" });
      }
      if (url.includes("/v1/gate/password")) {
        expect(init?.method).toBe("PUT");
        bodies.push(JSON.parse(String(init?.body)));
        return json({ ok: true });
      }
      return json({});
    });
    mount(fetchMock);

    await screen.findByTestId("security-key-form");
    fillForm("old-key", "new-key", "new-key");
    fireEvent.click(screen.getByTestId("security-key-save"));

    await waitFor(() => expect(screen.getByTestId("security-key-saved")).toBeTruthy());
    expect(bodies).toEqual([{ currentPassword: "old-key", newPassword: "new-key" }]);
    expect((screen.getByLabelText("Current key") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("New key") as HTMLInputElement).value).toBe("");
  });

  it("validates locally: mismatch and empty current key block submit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => json(
      String(input).includes("/v1/gate/status")
        ? { required: true, authenticated: true, mode: "local", status: "enabled" }
        : {},
    ));
    mount(fetchMock);
    await screen.findByTestId("security-key-form");

    fillForm("old", "abc", "xyz");
    expect(screen.getByTestId("security-key-local-error").textContent).toContain("do not match");
    expect(screen.getByTestId("security-key-save").hasAttribute("disabled")).toBe(true);

    fillForm("old", "abc", "abc");
    expect(screen.queryByTestId("security-key-local-error")).toBeNull();
    expect(screen.getByTestId("security-key-save").hasAttribute("disabled")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/v1/gate/password"), expect.anything());
  });

  it("maps the wrong-current-key wire failure to fixed copy", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/gate/status")) {
        return json({ required: true, authenticated: true, mode: "local", status: "enabled" });
      }
      if (url.includes("/v1/gate/password")) {
        return new Response(JSON.stringify({ ok: false, error: "Incorrect current password", message: "Incorrect current password", code: "INVALID_PASSWORD" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return json({});
    });
    mount(fetchMock);
    await screen.findByTestId("security-key-form");
    fillForm("wrong", "next-key", "next-key");
    fireEvent.click(screen.getByTestId("security-key-save"));
    await waitFor(() => expect(screen.getByTestId("security-key-error")).toBeTruthy());
    expect(screen.getByTestId("security-key-error").textContent).toContain("current key is incorrect");
  });

  it("shows honest notes for unconfigured and disabled gate states without a form", async () => {
    const states = [
      { expected: "security-key-unconfigured", status: "unconfigured" as const },
      { expected: "security-key-disabled", status: "disabled" as const },
    ];
    for (const state of states) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => json(
        String(input).includes("/v1/gate/status")
          ? { required: false, authenticated: false, mode: "local", status: state.status }
          : {},
      ));
      const view = mount(fetchMock);
      await screen.findByTestId(state.expected);
      expect(screen.queryByTestId("security-key-form")).toBeNull();
      view.unmount();
    }
  });

  it("describeGatePasswordError covers every fixed wire failure mode", () => {
    const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? JSON.stringify(params) : ""}`;
    expect(describeGatePasswordError(new HttpError({ status: 401, path: "/x", message: "x", code: "INVALID_PASSWORD" }), t))
      .toBe("desktop.securityKeyWrongCurrent");
    expect(describeGatePasswordError(new HttpError({ status: 409, path: "/x", message: "x", code: "PASSWORD_ENV_MANAGED" }), t))
      .toBe("desktop.securityKeyEnvManaged");
    expect(describeGatePasswordError(new HttpError({ status: 409, path: "/x", message: "x", code: "AUTH_DISABLED" }), t))
      .toBe("desktop.securityKeyDisabled");
    expect(describeGatePasswordError(new HttpError({ status: 429, path: "/x", message: "x", code: "RATE_LIMITED", retryAfterSeconds: 12 }), t))
      .toBe('desktop.securityKeyRateLimited{"seconds":12}');
    expect(describeGatePasswordError(new HttpError({ status: 400, path: "/x", message: "x" }), t))
      .toBe("desktop.securityKeyInvalidInput");
    expect(describeGatePasswordError(new HttpError({ status: 500, path: "/x", message: "x", code: "PASSWORD_WRITE_FAILED" }), t))
      .toBe("desktop.securityKeyWriteFailed");
    expect(describeGatePasswordError(new HttpError({ status: 503, path: "/x", message: "x" }), t))
      .toBe("desktop.securityKeyUnavailable");
    expect(describeGatePasswordError(new Error("boom"), t)).toBe("desktop.securityKeyGenericFailure");
  });
});
