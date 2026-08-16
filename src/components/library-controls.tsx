"use client";

import {
  COOKED_FILTERS,
  MEAL_TYPE_FILTERS,
  SORT_OPTIONS,
  type LibraryQuery,
} from "@/lib/library";

/**
 * Sort and filter for the library, as three dropdowns in one row.
 *
 * Previously eight wrapping chips plus a select, which stacked to four rows
 * and pushed the first recipe ~400px down a 844px screen — worse than the
 * Discover header it was sitting under. Same information, one row.
 */
export function LibraryControls({
  query,
  onChange,
  total,
  showing,
}: {
  query: LibraryQuery;
  onChange: (next: LibraryQuery) => void;
  total: number;
  showing: number;
}) {
  const filtered = query.cooked !== null || query.mealType !== null;

  return (
    <div className="mt-2">
      <div className="grid grid-cols-3 gap-2">
        <Field label="Sort">
          <select
            aria-label="Sort"
            value={query.sort}
            onChange={(e) =>
              onChange({ ...query, sort: e.target.value as LibraryQuery["sort"] })
            }
            className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {SORT_OPTIONS.find((s) => s.value === query.sort)?.label ?? "Sort"}
        </Field>

        <Field label="Cooked" on={query.cooked !== null}>
          <select
            aria-label="Cooked"
            value={query.cooked ?? ""}
            onChange={(e) =>
              onChange({
                ...query,
                cooked: (e.target.value || null) as LibraryQuery["cooked"],
              })
            }
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            <option value="">Any</option>
            {COOKED_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          {COOKED_FILTERS.find((f) => f.value === query.cooked)?.label ?? "Any"}
        </Field>

        <Field label="Meal" on={query.mealType !== null}>
          <select
            aria-label="Meal"
            value={query.mealType ?? ""}
            onChange={(e) =>
              onChange({
                ...query,
                mealType: (e.target.value || null) as LibraryQuery["mealType"],
              })
            }
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          >
            <option value="">Any</option>
            {MEAL_TYPE_FILTERS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          {MEAL_TYPE_FILTERS.find((m) => m.value === query.mealType)?.label ??
            "Any"}
        </Field>
      </div>

      {filtered && (
        <p className="figures-text mt-2 text-sm text-muted">
          {showing} of {total}
          <button
            type="button"
            onClick={() => onChange({ ...query, cooked: null, mealType: null })}
            className="ml-3 text-accent underline underline-offset-4 transition active:opacity-60"
          >
            Clear
          </button>
        </p>
      )}
    </div>
  );
}

/** Native select stretched invisibly over a labelled pill. */
function Field({
  label,
  on = false,
  children,
}: {
  label: string;
  on?: boolean;
  children: React.ReactNode;
}) {
  const [select, ...rest] = Array.isArray(children) ? children : [children];
  return (
    <div className="relative">
      <div
        aria-hidden
        className={`pointer-events-none flex h-[52px] flex-col justify-center rounded-[var(--radius-control)] border px-3 ${
          on ? "border-accent bg-accent-soft" : "border-line bg-surface"
        }`}
      >
        <span
          className={`text-[10px] leading-tight font-medium tracking-wide uppercase ${
            on ? "text-accent" : "text-muted"
          }`}
        >
          {label}
        </span>
        <span
          className={`truncate text-[14px] leading-tight ${
            on ? "font-semibold text-accent" : "text-ink"
          }`}
        >
          {rest}
        </span>
      </div>
      {select}
    </div>
  );
}
