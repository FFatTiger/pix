import { SegmentedControl } from "./settings-ui";
import { SMART_COMPACT_PROFILES, type SmartCompactProfileWire } from "@fffattiger/pix-protocol";
import { useI18n } from "@/hooks/useI18n";

/**
 * Compression-style segmented control (light / balanced / aggressive) — the
 * plugin's VALID_PROFILES surface, pinned 10.3.0.
 */
export function CompactionProfileControl({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: SmartCompactProfileWire;
  disabled?: boolean;
  onChange: (profile: SmartCompactProfileWire) => void;
}) {
  const { t } = useI18n();
  return (
    <div id={id}>
      <SegmentedControl<SmartCompactProfileWire>
        value={value}
        {...(disabled === undefined ? {} : { disabled })}
        ariaLabel={t("desktop.compactionProfile")}
        options={SMART_COMPACT_PROFILES.map((profile: SmartCompactProfileWire) => ({
          value: profile,
          label: t(`desktop.compactionProfile_${profile}`),
        }))}
        onChange={(next) => onChange(next)}
      />
    </div>
  );
}
