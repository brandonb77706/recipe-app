"use client";

import {
  CONCEPT_CHIPS,
  MEAL_CHIPS,
  MIN_CHIP_COUNT,
  PROTEIN_CHIPS,
  anyChipActive,
  availableTimeChips,
  type ChipFilters,
  type Facets,
} from "@/lib/filters";

type Option = { value: string; label: string; count: number | null };

/**
 * Four dropdowns, one per group, in a single row.
 *
 * Each pill shows its group name above the current selection, so the row reads
 * as four labelled controls rather than four mystery values — at 80px wide on
 * a phone, "Dinner" alone doesn't tell you which axis it's filtering.
 */
export function DiscoverFilters({
  chips,
  onChange,
  facets,
  maxMinutes,
  matching,
  poolSize,
}: {
  chips: ChipFilters;
  onChange: (next: ChipFilters) => void;
  facets: Facets | null;
  maxMinutes: number | null;
  matching: number;
  poolSize: number;
}) {
  const active = anyChipActive(chips);

  const count = (group: Record<string, number> | undefined, key: string) =>
    facets ? (group?.[key] ?? 0) : null;

  /** Drop options that would return almost nothing rather than render a dead one. */
  const enough = (group: Record<string, number> | undefined, key: string) =>
    !facets || (group?.[key] ?? 0) >= MIN_CHIP_COUNT;

  const timeOptions: Option[] = availableTimeChips(maxMinutes).map((t) => ({
    value: String(t),
    label: `Under ${t} min`,
    count: count(facets?.time, String(t)),
  }));

  const mealOptions: Option[] = MEAL_CHIPS.filter((m) =>
    enough(facets?.mealTypes, m.value)
  ).map((m) => ({
    value: m.value,
    label: m.label,
    count: count(facets?.mealTypes, m.value),
  }));

  const proteinOptions: Option[] = PROTEIN_CHIPS.filter((p) =>
    enough(facets?.proteins, p.value)
  ).map((p) => ({
    value: p.value,
    label: p.label,
    count: count(facets?.proteins, p.value),
  }));

  const styleOptions: Option[] = CONCEPT_CHIPS.filter((c) =>
    enough(facets?.concepts, c.value)
  ).map((c) => ({
    value: c.value,
    label: c.label,
    count: count(facets?.concepts, c.value),
  }));

  return (
    <div className="mt-2">
      <div className="grid grid-cols-4 gap-2">
        <Dropdown
          label="Time"
          empty="Any"
          options={timeOptions}
          value={chips.maxTime == null ? "" : String(chips.maxTime)}
          onChange={(v) =>
            onChange({ ...chips, maxTime: v === "" ? null : Number(v) })
          }
        />
        <Dropdown
          label="Meal"
          empty="Any"
          options={mealOptions}
          value={chips.mealTypes[0] ?? ""}
          onChange={(v) => onChange({ ...chips, mealTypes: v ? [v] : [] })}
        />
        <Dropdown
          label="Protein"
          empty="Any"
          options={proteinOptions}
          value={chips.proteins[0] ?? ""}
          onChange={(v) => onChange({ ...chips, proteins: v ? [v] : [] })}
        />
        <Dropdown
          label="Style"
          empty="Any"
          options={styleOptions}
          value={chips.concepts[0] ?? ""}
          onChange={(v) => onChange({ ...chips, concepts: v ? [v] : [] })}
        />
      </div>

      {active && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-base text-muted">
            <span className="font-semibold text-ink">
              {matching.toLocaleString()}
            </span>{" "}
            of {poolSize.toLocaleString()}
          </p>
          {/* Say what an active time filter costs, rather than silently
              dropping recipes whose time the source never published. */}
          {chips.maxTime != null && (facets?.hiddenNoTime ?? 0) > 0 && (
            <p className="text-base text-muted">
              · {facets!.hiddenNoTime.toLocaleString()} hidden, time unknown
            </p>
          )}
          <button
            type="button"
            onClick={() =>
              onChange({ maxTime: null, mealTypes: [], proteins: [], concepts: [] })
            }
            className="text-base text-accent underline underline-offset-4 transition active:opacity-60"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A native <select> made invisible and stretched over a custom pill.
 *
 * The picker itself stays native — on iOS that's the system wheel with proper
 * touch targets and VoiceOver support, which no custom panel matches — while
 * the visible pill is ours, so it can carry the group name and a selected
 * state. The select keeps focus and labelling; the pill is decoration.
 */
function Dropdown({
  label,
  empty,
  options,
  value,
  onChange,
}: {
  label: string;
  empty: string;
  options: Option[];
  value: string;
  onChange: (next: string) => void;
}) {
  const selected = options.find((o) => o.value === value);
  const on = selected != null;
  const disabled = options.length === 0;

  return (
    <div className="relative">
      <div
        aria-hidden
        className={`pointer-events-none flex h-[50px] flex-col justify-center rounded-2xl border px-3 transition ${
          on
            ? "border-accent bg-accent-soft"
            : "border-line bg-surface"
        } ${disabled ? "opacity-40" : ""}`}
      >
        <span
          className={`text-[11px] leading-tight font-medium tracking-wide uppercase ${
            on ? "text-accent" : "text-muted"
          }`}
        >
          {label}
        </span>
        <span className="flex items-center gap-1">
          <span
            className={`truncate text-[15px] leading-tight ${
              on ? "font-semibold text-accent" : "text-ink"
            }`}
          >
            {selected ? selected.label.replace(/^Under /, "≤") : empty}
          </span>
          <svg
            viewBox="0 0 24 24"
            className={`ml-auto h-3.5 w-3.5 shrink-0 ${
              on ? "text-accent" : "text-muted"
            }`}
          >
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>

      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
      >
        <option value="">{`${label}: ${empty}`}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.count != null ? ` (${o.count.toLocaleString()})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
