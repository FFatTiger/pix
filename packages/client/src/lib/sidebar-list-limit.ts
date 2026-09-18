export const SIDEBAR_VISIBLE_LIMIT = 5;

export function splitLimitedList<T>(items: readonly T[], expanded: boolean, limit = SIDEBAR_VISIBLE_LIMIT): {
  visible: T[];
  hiddenCount: number;
} {
  if (expanded || items.length <= limit) {
    return { visible: [...items], hiddenCount: 0 };
  }
  return {
    visible: items.slice(0, limit),
    hiddenCount: items.length - limit,
  };
}
