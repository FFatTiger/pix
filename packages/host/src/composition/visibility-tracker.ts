/**
 * Host-level page-visibility tracker (Web Push suppression, D-PUSH).
 *
 * Single in-memory owner of "is any connected client page visible right now".
 * The runtime WS gateway registers one entry per negotiating connection; a
 * connection that closes (or never negotiated `runtime.visibility.v1`) is
 * never visible — so a disconnected client can never suppress notifications.
 * Deliberately process-local: nothing is persisted, and the answer is only as
 * fresh as the live connections reporting it.
 */

/** Registration handle; drop the reference (or call unregister) to leave. */
export interface VisibilityRegistration {
  /** Update this connection's reported page visibility. */
  report(visible: boolean): void;
  /** Remove the connection entirely (treated as not visible). */
  unregister(): void;
}

export interface VisibilityTracker {
  /** Register a connection (initially NOT visible until its first report). */
  register(): VisibilityRegistration;
  /** True when at least one live connection reported a visible page. */
  hasVisible(): boolean;
}

export function createVisibilityTracker(): VisibilityTracker {
  const connections = new Set<VisibilityRegistration & { visible(): boolean }>();
  return {
    register() {
      let visible = false;
      let active = true;
      const registration: VisibilityRegistration & { visible(): boolean } = {
        report(next) {
          if (!active) return;
          visible = next;
        },
        unregister() {
          if (!active) return;
          active = false;
          connections.delete(registration);
        },
        visible() {
          return active && visible;
        },
      };
      connections.add(registration);
      return registration;
    },
    hasVisible() {
      for (const registration of connections) {
        if (registration.visible()) return true;
      }
      return false;
    },
  };
}
