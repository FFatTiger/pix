import { createContext, useContext, useEffect } from "react";

/**
 * Navigation-time dirty guard for the Settings dialog.
 *
 * Draft-based settings pages (model providers, tools, subagents,
 * settings.json, …) register a handle here. When the user switches pages or
 * closes the dialog while a draft has unsaved changes, the modal asks once
 * (inline confirm) and discards every dirty draft only on explicit consent.
 *
 * Outside the Settings dialog the context is a no-op, so pages stay
 * unit-testable without the modal shell.
 */

export interface SettingsDraftHandle {
  /** Read at navigation time so it always reflects the live draft. */
  isDirty: () => boolean;
  /** Drop the in-progress draft and return to the saved snapshot. */
  discard: () => void;
}

export interface SettingsDraftApi {
  /** Registers (or refreshes) the handle for one page; returns its unregister. */
  register: (id: string, handle: SettingsDraftHandle) => () => void;
}

const noopApi: SettingsDraftApi = {
  register: () => () => {},
};

export const SettingsDraftContext = createContext<SettingsDraftApi>(noopApi);

/**
 * Register the calling page's draft handle. Re-registers on every render so
 * the modal always sees the latest closures without stale-callback bugs.
 */
export function useSettingsDraft(id: string, handle: SettingsDraftHandle): void {
  const api = useContext(SettingsDraftContext);
  useEffect(() => api.register(id, handle));
}
