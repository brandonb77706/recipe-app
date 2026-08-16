"use client";

import type { Answer } from "@/lib/preferences";

/**
 * Chip pickers shared by /onboarding and /settings.
 *
 * The tri-state rule is enforced by the interaction, not just the type: the
 * only way to reach `[]` ("no preference") is to tap the No-preference chip.
 * Deselecting your last real choice returns to `null` ("unanswered"), so what
 * you see — nothing highlighted — always means the same thing as what's stored.
 */

type Option<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
};

function chipClass(selected: boolean, disabled: boolean) {
  return [
    "rounded-full border px-4 py-2.5 text-base transition select-none",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    selected
      ? "border-accent bg-accent font-semibold text-white"
      : "border-line bg-surface text-ink active:bg-accent-soft",
    disabled && !selected ? "opacity-35" : "",
  ].join(" ");
}

export function ChoiceGroup<T extends string>({
  legend,
  help,
  options,
  value,
  onChange,
  max,
  noPreferenceLabel = "No preference",
}: {
  legend: string;
  help?: string;
  options: readonly Option<T>[];
  value: Answer<T>;
  onChange: (next: Answer<T>) => void;
  /** Cap on real selections. The No-preference chip is never counted. */
  max?: number;
  noPreferenceLabel?: string;
}) {
  const chosen = value ?? [];
  const noPreference = value !== null && chosen.length === 0;
  const atCap = max != null && chosen.length >= max;

  const toggle = (option: T) => {
    if (chosen.includes(option)) {
      const next = chosen.filter((v) => v !== option);
      // Emptying the list is "I changed my mind", not "I don't care".
      onChange(next.length ? next : null);
      return;
    }
    if (atCap) return;
    onChange([...chosen, option]);
  };

  return (
    <fieldset>
      <legend className="font-display text-2xl leading-snug font-semibold text-balance">
        {legend}
      </legend>
      {help && <p className="mt-2 text-base text-muted">{help}</p>}

      <div className="mt-5 flex flex-wrap gap-2.5">
        {options.map((option) => {
          const selected = chosen.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              onClick={() => toggle(option.value)}
              className={chipClass(selected, atCap)}
            >
              {option.label}
              {option.hint && (
                <span
                  className={
                    selected
                      ? "ml-2 text-sm text-white/75"
                      : "ml-2 text-sm text-muted"
                  }
                >
                  {option.hint}
                </span>
              )}
            </button>
          );
        })}

        <button
          type="button"
          aria-pressed={noPreference}
          onClick={() => onChange(noPreference ? null : [])}
          className={chipClass(noPreference, false)}
        >
          {noPreferenceLabel}
        </button>
      </div>

      {max != null && (
        <p className="mt-3 text-sm text-muted">
          {atCap
            ? `That's ${max} — deselect one to swap.`
            : `Pick up to ${max}.`}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The strictness follow-up. Two tiers, because they mean different things:
 * strict runs an ingredient scan and drops the recipe on any trace, preference
 * only looks at what the dish is built around.
 *
 * Always answered — there's no third state here. This question only appears
 * for proteins already chosen, so "unanswered" isn't a situation that exists.
 */
export function StrictnessGroup<T extends string>({
  legend,
  help,
  options,
  selected,
  strict,
  onChange,
}: {
  legend: string;
  help?: string;
  options: readonly Option<T>[];
  /** The avoided proteins, in the order the user picked them. */
  selected: readonly T[];
  strict: readonly T[];
  onChange: (next: T[]) => void;
}) {
  const labelOf = (value: T) =>
    options.find((o) => o.value === value)?.label ?? value;

  const set = (value: T, isStrict: boolean) => {
    const without = strict.filter((v) => v !== value);
    onChange(isStrict ? [...without, value] : without);
  };

  return (
    <fieldset>
      <legend className="font-display text-2xl leading-snug font-semibold text-balance">
        {legend}
      </legend>
      {help && <p className="mt-2 text-base text-muted">{help}</p>}

      <div className="mt-5 space-y-3">
        {selected.map((value) => {
          const on = strict.includes(value);
          return (
            <div
              key={value}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3"
            >
              <span className="text-base font-semibold">{labelOf(value)}</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => set(value, true)}
                  className={chipClass(on, false) + " px-3 py-2 text-sm"}
                >
                  Strictly
                </button>
                <button
                  type="button"
                  aria-pressed={!on}
                  onClick={() => set(value, false)}
                  className={chipClass(!on, false) + " px-3 py-2 text-sm"}
                >
                  Just a preference
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-sm text-muted">
        Strict hides anything containing it at all, down to a garnish or a
        splash of sauce. A preference only hides dishes built around it.
      </p>
    </fieldset>
  );
}

/**
 * Single-select, so there's no empty-list state to confuse with intent:
 * `undefined` is unanswered and `null` is the explicit "no limit" answer.
 */
export function TimeChoice({
  legend,
  help,
  options,
  value,
  onChange,
}: {
  legend: string;
  help?: string;
  options: readonly { readonly value: number | null; readonly label: string }[];
  value: number | null | undefined;
  onChange: (next: number | null) => void;
}) {
  return (
    <fieldset>
      <legend className="font-display text-2xl leading-snug font-semibold text-balance">
        {legend}
      </legend>
      {help && <p className="mt-2 text-base text-muted">{help}</p>}

      <div className="mt-5 flex flex-wrap gap-2.5">
        {options.map((option) => {
          const selected = value !== undefined && value === option.value;
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={chipClass(selected, false)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
