import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  hasCapability,
  isAgentEnabled,
  type HostCapability,
  type HostInfo,
  type HostMode,
} from "@fffattiger/pix-protocol";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";

/**
 * Honest fallback capability set: when the host is unreachable the client
 * claims nothing. It does not fabricate a `files` capability it cannot verify
 * (architecture rule 14 / M1 honesty requirement).
 */
export const DEFAULT_READONLY_CAPABILITIES: readonly HostCapability[] = [];

export interface CapabilityContextValue {
  mode: HostMode;
  capabilities: readonly HostCapability[];
  canAgent: boolean;
  isReadonly: boolean;
  unavailable: boolean;
  /** True only when the host actually serves session history (sessiond up). */
  canBrowseSessions: boolean;
  /**
   * True only when the host actually serves the D4 session-history DELETE
   * (sessiond up AND the mutation seam mounted). Discovery only — the server
   * still enforces authorization and rejects live sessions with 409.
   */
  canDeleteSessions: boolean;
  /**
   * True only when the host actually serves the D4 session-history PATCH rename
   * (`session.write` token; sessiond up AND the mutation seam mounted).
   * Discovery only — the server still enforces authorization.
   */
  canWriteSessions: boolean;
  can: (capability: HostCapability) => boolean;
  host: HostInfo;
}

const CapabilityContext = createContext<CapabilityContextValue | null>(null);

export interface CapabilityProviderProps {
  children: ReactNode;
  /**
   * Explicit host override for tests/stories. Omit to query the real
   * /v1/bootstrap endpoint for capability, sessiond state, mode and gate.
   */
  host?: Partial<HostInfo> | null;
}

export function CapabilityProvider({ children, host }: CapabilityProviderProps) {
  const http = useHttpClient();
  const options = createQueryOptions(http);
  // The client consumes the real /v1/bootstrap boot surface — never a hardcoded
  // demo. Bootstrap carries the honest capability/sessiond projection.
  const query = useQuery({ ...options.capabilities.bootstrap(), enabled: host === undefined });
  const resolved = host === undefined && query.data
    ? { mode: query.data.mode, capabilities: query.data.capabilities, sessiond: query.data.sessiond }
    : host
      ? { mode: host.mode, capabilities: host.capabilities, sessiond: undefined as "up" | "down" | "unknown" | undefined }
      : undefined;
  const mode: HostMode = resolved?.mode ?? "local";
  const capabilities = resolved?.capabilities ?? DEFAULT_READONLY_CAPABILITIES;
  const canAgent = isAgentEnabled(capabilities);
  const value: CapabilityContextValue = {
    mode,
    capabilities,
    canAgent,
    isReadonly: !canAgent,
    unavailable: host === undefined && (query.isError || query.data?.sessiond !== "up"),
    // Session history (read-only catalog) is reachable ONLY when the host
    // advertises the negotiated `sessions` capability token — never inferred
    // from sessiond liveness alone. While down the token is retracted, the
    // sidebar stays disabled, and the client never requests /v1/sessions.
    canBrowseSessions: hasCapability(capabilities, "sessions"),
    canDeleteSessions: hasCapability(capabilities, "session.delete"),
    canWriteSessions: hasCapability(capabilities, "session.write"),
    can: (capability) => hasCapability(capabilities, capability),
    host: { mode, capabilities: [...capabilities] },
  };
  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

export function useCapabilities(): CapabilityContextValue {
  const ctx = useContext(CapabilityContext);
  if (!ctx) throw new Error("useCapabilities must be used within CapabilityProvider");
  return ctx;
}
