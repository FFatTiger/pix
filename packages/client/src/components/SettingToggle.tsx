import { Switch } from "@/components/ui/switch";

/** Row layout: label + description on the left, switch on the right. */
export function SettingToggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  loading,
  monoDescription,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: React.ReactNode;
  /** Render the description in the mono font (e.g. raw tool ids). */
  monoDescription?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <label className={description ? "settings-toggle-row has-description" : "settings-toggle-row"}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13,
            fontWeight: 550,
            color: "var(--text)",
            lineHeight: 1.4,
            opacity: disabled ? 0.55 : 1,
          }}
        >
          {label}
        </span>
        {description && (
          <span
            style={{
              display: "block",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--text-muted)",
              marginTop: 2,
              opacity: disabled ? 0.55 : 1,
              fontFamily: monoDescription ? "var(--font-mono)" : undefined,
            }}
          >
            {description}
          </span>
        )}
      </span>
      <Switch
        checked={checked}
        onChange={onChange}
        label={label}
        disabled={disabled}
        loading={loading}
      />
    </label>
  );
}
