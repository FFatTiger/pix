/**
 * Canonical auth DTOs for {@link CredentialStorePort}.
 *
 * The port accepts credentials as input but **never returns them**: status
 * objects carry only authorization state and display metadata. This is a
 * hard boundary — no raw API keys, tokens or secrets may cross it.
 */

export type AuthProviderKind = "oauth" | "apiKey" | "deviceCode";

export interface AuthProviderInfo {
  id: string;
  name?: string;
  /** Supported authorization methods; one provider row may support several. */
  methods: readonly AuthProviderKind[];
}

export interface AuthProviderStatus {
  providerId: string;
  authorized: boolean;
  /** Display name of the authorized account, when known. */
  accountName?: string;
  expiresAt?: number;
}

/**
 * Credential input for authorization. Credentials flow in one direction only:
 * they are consumed by the backend and never exposed by any port method.
 */
export type AuthInput =
  | { type: "apiKey"; apiKey: string }
  | { type: "oauth"; code?: string }
  | { type: "deviceCode"; code?: string }
  | { type: "start" };

export interface AuthResult {
  providerId: string;
  authorized: boolean;
  /**
   * Pending interactive-flow info (device-code URL + one-time user code).
   * Never secrets.
   */
  pending?: {
    verificationUrl?: string;
    userCode?: string;
    expiresAt?: number;
  };
  accountName?: string;
}
