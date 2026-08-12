import { useQuery } from "@tanstack/react-query";
import { createQueryOptions } from "@/api/query-keys";
import { useHttpClient } from "@/app/http-context";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import type { TrustResponse } from "@/api/schemas";
import { describeCatalogError } from "./catalog-errors";

export interface TrustBadgeProps {
  /** Workspace cwd. When missing the badge issues ZERO requests. */
  cwd: string | undefined;
  /** Compact badge for sidebar, or inline summary for panel footer/header. */
  variant?: "badge" | "summary";
}

/**
 * Project trust indicator. Queries only when resources cap is negotiated AND
 * cwd is present. Never displays host path/secret/raw error text.
 */
export function TrustBadge({ cwd, variant = "badge" }: TrustBadgeProps) {
  const http = useHttpClient();
  const { can } = useCapabilities();
  // Trust is gated by resources visibility (skills || plugins). Host mounts
  // /v1/trust independently of resources, but product decision: only surface
  // trust when project resource catalogs are relevant.
  const canResources = can("skills") || can("plugins");
  const enabled = canResources && Boolean(cwd);
  const trust = useQuery({
    ...createQueryOptions(http).trust.get(cwd ?? ""),
    enabled,
  });

  if (!canResources) return null;
  if (!cwd) return null;

  if (trust.isLoading) {
    return variant === "summary"
      ? <p className="workspace-hint">Loading trust…</p>
      : <span className="trust-badge trust-badge--muted" title="Loading trust">Trust…</span>;
  }

  if (trust.isError) {
    const copy = describeCatalogError(trust.error);
    return variant === "summary"
      ? <p className="workspace-hint workspace-hint--error" role="alert">{copy}</p>
      : <span className="trust-badge trust-badge--error" title={copy}>Trust?</span>;
  }

  const data = trust.data as TrustResponse | undefined;
  if (!data) return null;

  const level = data.level;
  const label = level === "trusted" ? "Trusted" : level === "denied" ? "Denied" : "Unknown";
  const className =
    level === "trusted"
      ? "trust-badge trust-badge--ok"
      : level === "denied"
        ? "trust-badge trust-badge--danger"
        : "trust-badge trust-badge--muted";

  if (variant === "summary") {
    const reload = data.canReloadResources;
    return (
      <div className="catalog-trust-summary" data-level={level}>
        <span className={className}>{label}</span>
        <span className="catalog-trust-detail">
          {data.trusted ? "Project resources trusted" : "Project resources not trusted"}
          {reload.allowed
            ? " · reload allowed"
            : reload.reason
              ? ` · ${reload.reason}`
              : " · reload denied"}
        </span>
      </div>
    );
  }

  return (
    <span className={className} title={`Project trust: ${label}`}>
      {label}
    </span>
  );
}
