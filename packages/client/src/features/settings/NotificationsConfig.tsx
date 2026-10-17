import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHttpClient } from "@/app/http-context";
import { createMutationOptions, createQueryOptions, createPushApi } from "@/api";
import { HttpError } from "@/api/http-client";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useI18n } from "@/hooks/useI18n";
import { Switch } from "@/components/ui/switch";
import { SettingsBadge, SettingsButton, SettingsRow, SettingsSection, SettingsWarningBanner } from "@/features/settings/settings-ui";
import {
  currentPushEndpoint,
  detectPushCapability,
  isIosWithoutStandalone,
  registerDevicePush,
  unregisterDevicePush,
  type NotificationStaticLike,
  type PushBrowserEnv,
  type PushCapability,
  type ServiceWorkerContainerLike,
} from "@/lib/push-subscription";

/**
 * Fixed i18n'd copy for push failures (AGENTS §4): every wire failure of the
 * push mutations maps to exactly one key; unknown failures use the generic key.
 */
export function describePushError(error: unknown, t: (key: string) => string): string {
  if (error instanceof HttpError) {
    if (error.status === 410 || error.code === "PUSH_SUBSCRIPTION_EXPIRED") return t("desktop.pushExpired");
    if (error.status === 404 || error.code === "PUSH_SUBSCRIPTION_NOT_FOUND") return t("desktop.pushNoSubscription");
    if (error.status === 502 || error.code === "PUSH_SEND_FAILED") return t("desktop.pushSendFailed");
    if (error.status === 500) return t("desktop.pushStoreFailed");
  }
  return t("desktop.pushGenericFailure");
}

/** Collect the (nullable) browser surfaces once per mount, guarded for SSR. */
export function readPushBrowserEnv(globalish: {
  navigator?: { userAgent?: string; serviceWorker?: unknown } | undefined;
  Notification?: unknown | undefined;
  matchMedia?: ((q: string) => { matches: boolean }) | undefined;
  window?: { PushManager?: unknown } | undefined;
}): { env: PushBrowserEnv; iosWithoutStandalone: boolean } {
  const serviceWorker = globalish.navigator?.serviceWorker ?? null;
  const hasPushManager = typeof globalish.window !== "undefined" && "PushManager" in globalish.window;
  const env: PushBrowserEnv = {
    serviceWorker: (serviceWorker ?? null) as ServiceWorkerContainerLike | null,
    notification: (globalish.Notification ?? null) as NotificationStaticLike | null,
    hasPushManager,
  };
  const userAgent = globalish.navigator?.userAgent ?? "";
  const platform = /iPhone|iPad|iPod/i.test(userAgent) ? "ios" : "other";
  const standalone = globalish.matchMedia?.("(display-mode: standalone)")?.matches === true;
  return { env, iosWithoutStandalone: isIosWithoutStandalone(platform, standalone) };
}

/**
 * Notifications settings (this device): the Web Push subscription switch, the
 * test button and honest state copy (unsupported / denied by the browser / iOS
 * home-screen hint). The permission request fires only from the switch click.
 */
export function NotificationsConfig() {
  const { t } = useI18n();
  const http = useHttpClient();
  const queryClient = useQueryClient();
  const { can } = useCapabilities();
  const canPush = can("push");

  const { env, iosWithoutStandalone } = useMemo(
    () => readPushBrowserEnv({
      navigator: typeof navigator === "undefined" ? undefined : navigator,
      Notification: typeof Notification === "undefined" ? undefined : Notification,
      // Bind the native getter: a detached `matchMedia` reference throws
      // "Illegal invocation" when readPushBrowserEnv calls it, which would
      // crash the whole settings dialog in a real browser.
      matchMedia: typeof matchMedia === "function" ? matchMedia.bind(globalThis) : undefined,
      window: typeof window === "undefined" ? undefined : window,
    }),
    [],
  );
  const capability: PushCapability = useMemo(() => detectPushCapability(env), [env]);

  const pushApi = useMemo(() => createPushApi(http), [http]);
  const configQuery = useQuery({
    ...createQueryOptions(http).push.config(),
    enabled: canPush,
  });
  const mutations = useMemo(() => createMutationOptions(http, queryClient).push, [http, queryClient]);
  const subscribeMutation = useMutation(mutations.subscribe());
  const unsubscribeMutation = useMutation(mutations.unsubscribe());
  const testMutation = useMutation(mutations.test());

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testSent, setTestSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void currentPushEndpoint(env).then((current) => {
      if (!cancelled) setEndpoint(current);
    });
    return () => {
      cancelled = true;
    };
  }, [env]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setMessage(null);
      setTestSent(false);
      setBusy(true);
      try {
        if (next) {
          const outcome = await registerDevicePush({
            env,
            getConfig: () => pushApi.config(),
            subscribe: (payload) => subscribeMutation.mutateAsync(payload),
          });
          if (outcome.state === "permission-denied") {
            setMessage(t("desktop.pushPermissionDenied"));
          } else if (outcome.state === "permission-dismissed") {
            setMessage(t("desktop.pushPermissionDismissed"));
          } else if (outcome.state === "unsupported") {
            setMessage(t("desktop.pushUnsupported"));
          } else {
            setEndpoint(outcome.endpoint);
            setMessage(t("desktop.pushEnabled"));
          }
        } else {
          await unregisterDevicePush({
            env,
            unsubscribe: (target) => unsubscribeMutation.mutateAsync(target),
          });
          setEndpoint(null);
          setMessage(t("desktop.pushDisabled"));
        }
      } catch (error) {
        setMessage(describePushError(error, t));
      } finally {
        setBusy(false);
      }
    },
    [env, pushApi, subscribeMutation, unsubscribeMutation, t],
  );

  const onTest = useCallback(() => {
    if (endpoint === null) return;
    setMessage(null);
    setTestSent(false);
    testMutation.mutate(endpoint, {
      onSuccess: () => setTestSent(true),
      onError: (error) => setMessage(describePushError(error, t)),
    });
  }, [endpoint, t, testMutation]);

  const supportedHost = canPush && configQuery.data?.supported === true;
  const permissionDenied = capability.state === "supported" && capability.permission === "denied";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
      <SettingsSection title={t("desktop.pushSectionTitle")}>
        {iosWithoutStandalone ? (
          <SettingsWarningBanner>{t("desktop.pushIosHomeScreen")}</SettingsWarningBanner>
        ) : null}
        {!canPush ? (
          <SettingsWarningBanner>{t("desktop.pushHostUnavailable")}</SettingsWarningBanner>
        ) : capability.state === "unsupported" ? (
          <SettingsRow
            label={t("desktop.pushToggleLabel")}
            description={t("desktop.pushUnsupportedDescription")}
          >
            <SettingsBadge tone="muted">{t("desktop.pushUnsupportedBadge")}</SettingsBadge>
          </SettingsRow>
        ) : (
          <SettingsRow
            label={t("desktop.pushToggleLabel")}
            description={permissionDenied ? t("desktop.pushPermissionDeniedDescription") : t("desktop.pushToggleDescription")}
          >
            <Switch
              checked={endpoint !== null}
              onChange={(next) => void handleToggle(next)}
              disabled={!supportedHost || busy || permissionDenied || iosWithoutStandalone}
              loading={busy}
              label={t("desktop.pushToggleLabel")}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label={t("desktop.pushTestLabel")}
          description={t("desktop.pushTestDescription")}
        >
          <SettingsButton
            variant="default"
            disabled={endpoint === null || testMutation.isPending}
            onClick={onTest}
            testId="push-test-button"
          >
            {t("desktop.pushTestButton")}
          </SettingsButton>
        </SettingsRow>
        {message ? <SettingsWarningBanner>{message}</SettingsWarningBanner> : null}
        {testSent ? <SettingsWarningBanner>{t("desktop.pushTestSent")}</SettingsWarningBanner> : null}
      </SettingsSection>
    </div>
  );
}
