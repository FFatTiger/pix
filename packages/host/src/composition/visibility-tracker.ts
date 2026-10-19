/**
 * Host-level page-attention tracker (Web Push suppression, D-PUSH).
 *
 * Single in-memory owner of "which push endpoints belong to a device that is
 * currently being looked at". The runtime WS gateway registers one entry per
 * negotiating connection; a connection reports `{ visible, attended?,
 * pushEndpointHash? }` where `attended` means the page is visible AND focused.
 * Suppression is per ENDPOINT, never global: only a live connection that
 * reports `attended: true` together with a push endpoint hash suppresses that
 * one endpoint — every other subscribed device still gets its notification.
 * A legacy boolean-only report maps to no endpoint and suppresses nothing; a
 * connection that closes (or never negotiated `runtime.visibility.v1`) is
 * unregistered, so a disconnected client can never suppress notifications.
 * Deliberately process-local: nothing is persisted, and the answer is only as
 * fresh as the live connections reporting it.
 */

/** One connection's report (the negotiated `visibility` frame payload). */
export interface VisibilityReport {
  /** Page visibility (legacy boolean; on its own it never suppresses). */
  readonly visible: boolean;
  /** Page is visible AND focused — the device is being looked at. */
  readonly attended?: boolean | undefined;
  /** Lowercase SHA-256 hex of this browser's push subscription endpoint. */
  readonly pushEndpointHash?: string | undefined;
}

/** Registration handle; drop the reference (or call unregister) to leave. */
export interface VisibilityRegistration {
  /** Update this connection's reported page attention. */
  report(report: VisibilityReport): void;
  /** Remove the connection entirely (never suppresses after this). */
  unregister(): void;
}

export interface VisibilityTracker {
  /** Register a connection (initially NOT attended until its first report). */
  register(): VisibilityRegistration;
  /**
   * Endpoint hashes with at least one live connection reporting an attended
   * page. Pushes to these endpoints are suppressed; every other subscription
   * still receives its notification.
   */
  attendedEndpointHashes(): Set<string>;
}

interface TrackedConnection {
  active: boolean;
  visible: boolean;
  attended: boolean;
  endpointHash: string | undefined;
}

export function createVisibilityTracker(): VisibilityTracker {
  const connections = new Set<TrackedConnection>();
  return {
    register() {
      const entry: TrackedConnection = { active: true, visible: false, attended: false, endpointHash: undefined };
      connections.add(entry);
      return {
        report(next) {
          if (!entry.active) return;
          entry.visible = next.visible;
          // Suppression requires the full attended evidence: a report that is
          // not visible, or a legacy report without attended, never suppresses.
          entry.attended = next.attended === true && next.visible;
          entry.endpointHash = next.pushEndpointHash;
        },
        unregister() {
          if (!entry.active) return;
          entry.active = false;
          connections.delete(entry);
        },
      };
    },
    attendedEndpointHashes() {
      const hashes = new Set<string>();
      for (const entry of connections) {
        if (entry.attended && entry.endpointHash !== undefined) hashes.add(entry.endpointHash);
      }
      return hashes;
    },
  };
}
