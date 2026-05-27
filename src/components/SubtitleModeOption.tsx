/**
 * Radio-option card used by the subtitle export dialog. Extracted to keep
 * `SubtitleExportDialog.tsx` short.
 */
export type SubtitleMode = "soft" | "burn";

interface SubtitleModeOptionProps {
  value: SubtitleMode;
  current: SubtitleMode;
  title: string;
  description: string;
  onSelect: (m: SubtitleMode) => void;
}

export function SubtitleModeOption({
  value,
  current,
  title,
  description,
  onSelect,
}: SubtitleModeOptionProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:bg-accent/30">
      <input
        type="radio"
        name="mode"
        value={value}
        checked={current === value}
        onChange={() => onSelect(value)}
        className="mt-1"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}
