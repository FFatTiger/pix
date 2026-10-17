import type { Locale, TranslationParams } from "./types";

type MessagesByLocale = Partial<Record<Locale, Record<string, string>>>;

export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const message = messages[locale]?.[key] ?? messages.en?.[key];
  if (message === undefined) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return interpolateMessage(message, params);
}

const COMPACT_MONTHS: Record<Locale, readonly string[]> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  "zh-CN": ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
};

/**
 * Sidebar activity chip. Buckets match the old NOW/M/H/D chip, but the words
 * come from the active locale: zh "刚刚" / "12分钟" / "5小时" / "昨天" / "3天" /
 * "10月12日", en "now" / "12m" / "5h" / "yesterday" / "3d" / "Oct 12".
 */
export function formatCompactActivity(ms: number, locale: Locale, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return locale === "zh-CN" ? "刚刚" : "now";
  if (mins < 60) return locale === "zh-CN" ? `${mins}分钟` : `${mins}m`;
  if (hours < 24) return locale === "zh-CN" ? `${hours}小时` : `${hours}h`;
  if (days === 1) return locale === "zh-CN" ? "昨天" : "yesterday";
  if (days < 7) return locale === "zh-CN" ? `${days}天` : `${days}d`;
  const date = new Date(ms);
  const month = COMPACT_MONTHS[locale][date.getMonth()] ?? "";
  const day = date.getDate();
  return locale === "zh-CN" ? `${month}${day}日` : `${month} ${day}`;
}

export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}
