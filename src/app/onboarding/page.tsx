"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChoiceGroup,
  StrictnessGroup,
  TimeChoice,
} from "@/components/preference-fields";
import {
  CONCEPT_CHOICES,
  CUISINE_CHOICES,
  DIET_NEEDS,
  MAX_FAVORITE_CUISINES,
  PROTEIN_CHOICES,
  TIME_OPTIONS,
  conceptsFromRow,
  hasPreference,
  reconcileStrict,
  type Answer,
  type ConceptChoice,
  type CuisineChoice,
  type DietNeed,
  type Preferences,
  type ProteinChoice,
} from "@/lib/preferences";

type Draft = {
  max_minutes: number | null | undefined;
  diets: Answer<DietNeed>;
  avoid_proteins: Answer<ProteinChoice>;
  strict_proteins: ProteinChoice[] | null;
  favorite_cuisines: Answer<CuisineChoice>;
  prefer_concepts: Answer<ConceptChoice>;
};

const EMPTY: Draft = {
  max_minutes: undefined,
  diets: null,
  avoid_proteins: null,
  strict_proteins: null,
  favorite_cuisines: null,
  prefer_concepts: null,
};

type StepKey =
  | "max_minutes"
  | "diets"
  | "avoid_proteins"
  | "strict_proteins"
  | "favorite_cuisines"
  | "prefer_concepts";

/**
 * The strictness follow-up only exists if something is actually avoided, so
 * the step list is derived from the draft rather than fixed.
 */
function stepsFor(draft: Draft): StepKey[] {
  return [
    "max_minutes",
    "diets",
    "avoid_proteins",
    ...(hasPreference(draft.avoid_proteins)
      ? (["strict_proteins"] as const)
      : []),
    "favorite_cuisines",
    "prefer_concepts",
  ];
}

export default function Onboarding() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-running onboarding shouldn't wipe answers you already gave.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/preferences");
        const body = await res.json();
        const p: Preferences | null = body?.preferences ?? null;
        if (cancelled || !p) return;
        setDraft({
          max_minutes: p.max_minutes,
          diets: p.diets,
          avoid_proteins: p.avoid_proteins,
          strict_proteins: p.strict_proteins,
          favorite_cuisines: p.favorite_cuisines,
          prefer_concepts: conceptsFromRow(p),
        });
      } catch {
        // A failed prefill just means starting empty — not worth blocking on.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = stepsFor(draft);
  // Clamp: dropping the last avoided protein removes a step from under us.
  const current = Math.min(step, steps.length - 1);
  const key = steps[current];
  const last = current === steps.length - 1;
  const answered =
    key === "max_minutes"
      ? draft.max_minutes !== undefined
      : key === "strict_proteins"
        ? true // seeded with defaults, so it always has an answer
        : draft[key] !== null;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Keep strictness in step with what's actually avoided.
  const setAvoided = (v: Answer<ProteinChoice>) =>
    setDraft((d) => ({
      ...d,
      avoid_proteins: v,
      strict_proteins: reconcileStrict(v, d.avoid_proteins, d.strict_proteins),
    }));

  const advance = () => {
    setError(null);
    if (!last) {
      setStep(current + 1);
      return;
    }
    void finish();
  };

  const finish = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, completed: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Save failed (${res.status})`);
      router.replace("/");  // straight into Discover
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save your answers.");
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2rem+env(safe-area-inset-bottom))] sm:px-8">
      <div className="mb-10 flex gap-1.5" aria-hidden>
        {steps.map((s, i) => (
          <span
            key={s}
            className={`h-1 flex-1 rounded-full transition ${
              i <= current ? "bg-accent" : "bg-line"
            }`}
          />
        ))}
      </div>

      <div className="flex-1">
        {loading ? (
          <div className="space-y-4">
            <div className="h-8 w-3/4 animate-pulse rounded bg-line/60" />
            <div className="h-11 w-full animate-pulse rounded-full bg-line/60" />
          </div>
        ) : (
          <Question draft={draft} step={key} set={set} setAvoided={setAvoided} />
        )}
      </div>

      {error && <p className="mt-6 text-base text-accent">{error}</p>}

      <div className="mt-10 flex items-center gap-3">
        {current > 0 && (
          <button
            type="button"
            onClick={() => setStep(current - 1)}
            disabled={saving}
            className="h-13 rounded-2xl px-5 text-base text-muted transition active:opacity-60 disabled:opacity-40"
          >
            Back
          </button>
        )}

        <button
          type="button"
          onClick={advance}
          disabled={loading || saving || !answered}
          className="h-13 flex-1 rounded-2xl bg-accent px-7 text-base font-semibold text-white transition active:opacity-90 disabled:opacity-40"
        >
          {saving ? "Saving…" : last ? "Start cooking" : "Continue"}
        </button>
      </div>

      {/* Skipping leaves the answer null, which the ranker reads as "never
          asked" — different from the No-preference chip, which is a decision. */}
      <button
        type="button"
        onClick={advance}
        disabled={loading || saving || answered}
        className="mt-4 h-11 text-base text-muted transition active:opacity-60 disabled:invisible"
      >
        Skip this one
      </button>
    </div>
  );
}

function Question({
  draft,
  step,
  set,
  setAvoided,
}: {
  draft: Draft;
  step: StepKey;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  setAvoided: (v: Answer<ProteinChoice>) => void;
}) {
  switch (step) {
    case "max_minutes":
      return (
        <TimeChoice
          legend="How long do you want to spend cooking?"
          help="On a normal weeknight. You can always ignore it for a weekend project."
          options={TIME_OPTIONS}
          value={draft.max_minutes}
          onChange={(v) => set("max_minutes", v)}
        />
      );
    case "diets":
      return (
        <ChoiceGroup
          legend="Anything you need to avoid?"
          help="These are strict — recipes that break them never appear."
          options={DIET_NEEDS}
          value={draft.diets}
          onChange={(v) => set("diets", v)}
          noPreferenceLabel="No restrictions"
        />
      );
    case "avoid_proteins":
      return (
        <ChoiceGroup
          legend="Any proteins you'd rather not see?"
          help="Not an allergy — just things you don't want showing up."
          options={PROTEIN_CHOICES}
          value={draft.avoid_proteins}
          onChange={setAvoided}
          noPreferenceLabel="I eat everything"
        />
      );
    case "strict_proteins":
      return (
        <StrictnessGroup
          legend="Strictly, or just not your preference?"
          help="It changes how hard we look. Pork and shellfish start strict because that's usually why people avoid them."
          options={PROTEIN_CHOICES}
          selected={draft.avoid_proteins ?? []}
          strict={draft.strict_proteins ?? []}
          onChange={(v) => set("strict_proteins", v)}
        />
      );
    case "favorite_cuisines":
      return (
        <ChoiceGroup
          legend="Which cuisines do you reach for most?"
          help="These get surfaced first. Everything else still shows up."
          options={CUISINE_CHOICES}
          value={draft.favorite_cuisines}
          onChange={(v) => set("favorite_cuisines", v)}
          max={MAX_FAVORITE_CUISINES}
          noPreferenceLabel="Surprise me"
        />
      );
    case "prefer_concepts":
      return (
        <ChoiceGroup
          legend="What are you usually after?"
          help="Ranking nudges, not filters — nothing gets hidden because of these."
          options={CONCEPT_CHOICES}
          value={draft.prefer_concepts}
          onChange={(v) => set("prefer_concepts", v)}
          noPreferenceLabel="Nothing in particular"
        />
      );
  }
}
