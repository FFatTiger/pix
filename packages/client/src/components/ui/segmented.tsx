/**
 * Segmented control (components/ui) for 2–4 mutually exclusive short
 * options — the settings replacement for "toggle + select" or ad-hoc button
 * groups. Moved from settings-ui.tsx; the .segmented classes are unchanged.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel} data-disabled={disabled ? "true" : undefined}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            className={active ? "segmented-item is-active" : "segmented-item"}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
