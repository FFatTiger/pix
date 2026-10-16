import { z } from "zod";
import { IsoTimestampSchema, NonEmptyStringSchema } from "./common.js";

/**
 * GET /v1/about — read-only Pix build/runtime facts.
 *
 * Every version string is resolved at runtime from the actually installed
 * package manifests (host package.json, pi-coding-agent, bundled curated
 * plugins); nothing here is compiled in or maintained by hand.
 */
export const AboutBuildInfoSchema = z.strictObject({
  /** Short commit hash of the build source, when the deployment provides one. */
  hash: NonEmptyStringSchema.optional(),
  /** ISO-8601 build instant, when the deployment provides one. */
  builtAt: IsoTimestampSchema.optional(),
});
export type AboutBuildInfo = z.infer<typeof AboutBuildInfoSchema>;

/**
 * One bundled curated plugin: `id` is the adapter's curated-plugin id
 * (subagents / todo / …), `name` the installed npm package name, `version`
 * read from the installed manifest.
 */
export const AboutPluginSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  version: NonEmptyStringSchema,
});
export type AboutPlugin = z.infer<typeof AboutPluginSchema>;

export const AboutResponseSchema = z.strictObject({
  pix: z.strictObject({
    version: NonEmptyStringSchema,
    build: AboutBuildInfoSchema.optional(),
  }),
  pi: z.strictObject({
    /** Version of the installed `@earendil-works/pi-coding-agent`. */
    codingAgent: NonEmptyStringSchema,
  }),
  /** `process.versions.node` of the running host. */
  node: NonEmptyStringSchema,
  /** `process.platform` / `process.arch` of the running host (raw Node vocabulary). */
  platform: NonEmptyStringSchema,
  arch: NonEmptyStringSchema,
  plugins: z.array(AboutPluginSchema),
});
export type AboutResponse = z.infer<typeof AboutResponseSchema>;

/**
 * POST /v1/about/check-update — bounded npm `latest` dist-tag probe for
 * the distributed pix CLI package.
 *
 * `latest === null` means the registry could not be reached or did not answer
 * with a usable version within the bounded timeout (the client renders the
 * fixed "cannot connect" outcome); `updateAvailable` is then always false.
 * `latest` without `updateAvailable` can also mean the fetched version is not
 * plain semver — the comparison fails closed instead of guessing. `package`
 * names the npm package the host probed (the client never hardcodes a
 * sibling package name; it composes the install command from this field).
 */
export const AboutCheckUpdateResponseSchema = z.strictObject({
  current: NonEmptyStringSchema,
  latest: NonEmptyStringSchema.nullable(),
  updateAvailable: z.boolean(),
  package: NonEmptyStringSchema,
});
export type AboutCheckUpdateResponse = z.infer<typeof AboutCheckUpdateResponseSchema>;
