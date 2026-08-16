"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
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

type SaveState = "idle" | "saving" | "saved" | "error";

export default function Settings() {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");

  // Chip taps come in bursts; one PUT per burst is plenty.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Draft>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/preferences");
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
        if (cancelled) return;
        const p: Preferences | null = body.preferences ?? null;
        if (p) {
          setDraft({
            max_minutes: p.max_minutes,
            diets: p.diets,
            avoid_proteins: p.avoid_proteins,
            strict_proteins: p.strict_proteins,
            favorite_cuisines: p.favorite_cuisines,
            prefer_concepts: conceptsFromRow(p),
          });
        }
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : "Something went wrong");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length === 0) return;

    setSave("saving");
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      setSave("saved");
    } catch {
      setSave("error");
    }
  }, []);

  const set = useCallback(
    <K extends keyof Draft>(k: K, v: Draft[K]) => {
      setDraft((d) => ({ ...d, [k]: v }));
      pending.current = { ...pending.current, [k]: v };
      setSave("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 500);
    },
    [flush]
  );

  // Both fields move together, so they save together — a PUT carrying only
  // avoid_proteins would null the strictness the server just reconciled.
  const setAvoided = useCallback(
    (v: Answer<ProteinChoice>) => {
      setDraft((d) => {
        const strict_proteins = reconcileStrict(v, d.avoid_proteins, d.strict_proteins);
        pending.current = {
          ...pending.current,
          avoid_proteins: v,
          strict_proteins,
        };
        return { ...d, avoid_proteins: v, strict_proteins };
      });
      setSave("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 500);
    },
    [flush]
  );

  return (
    <div className="mx-auto w-full max-w-xl px-5 pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(var(--nav-h)+2rem+env(safe-area-inset-bottom))] sm:px-8">
      <header className="mb-9">
        <Link
          href="/"
          className="text-base text-muted transition active:opacity-60"
        >
          ← Discover
        </Link>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight">
          Preferences
        </h1>
        <p className="mt-2 h-6 text-base text-muted">
          {save === "saving" && "Saving…"}
          {save === "saved" && "Saved"}
          {save === "error" && (
            <span className="text-accent">Couldn’t save — check your connection.</span>
          )}
        </p>
      </header>

      {status === "loading" && (
        <div className="space-y-10">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-4">
              <div className="h-7 w-2/3 animate-pulse rounded bg-line/60" />
              <div className="h-11 w-full animate-pulse rounded-full bg-line/60" />
            </div>
          ))}
        </div>
      )}

      {status === "error" && (
        <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
          <p className="font-display text-2xl font-semibold">
            Couldn’t load your preferences
          </p>
          <p className="mx-auto mt-2 max-w-sm text-base text-muted">
            {loadError ?? "Unknown error"}
          </p>
        </div>
      )}

      {status === "ready" && (
        <div className="space-y-11">
          <TimeChoice
            legend="Weeknight time limit"
            help="Recipes over this are filtered out of Discover."
            options={TIME_OPTIONS}
            value={draft.max_minutes}
            onChange={(v) => set("max_minutes", v)}
          />

          <ChoiceGroup
            legend="Dietary needs"
            help="Strict — recipes that break these never appear."
            options={DIET_NEEDS}
            value={draft.diets}
            onChange={(v) => set("diets", v)}
            noPreferenceLabel="No restrictions"
          />

          <ChoiceGroup
            legend="Proteins to avoid"
            options={PROTEIN_CHOICES}
            value={draft.avoid_proteins}
            onChange={setAvoided}
            noPreferenceLabel="I eat everything"
          />

          {hasPreference(draft.avoid_proteins) && (
            <StrictnessGroup
              legend="How strictly?"
              options={PROTEIN_CHOICES}
              selected={draft.avoid_proteins}
              strict={draft.strict_proteins ?? []}
              onChange={(v) => set("strict_proteins", v)}
            />
          )}

          <ChoiceGroup
            legend="Favourite cuisines"
            help="Surfaced first. Everything else still shows up."
            options={CUISINE_CHOICES}
            value={draft.favorite_cuisines}
            onChange={(v) => set("favorite_cuisines", v)}
            max={MAX_FAVORITE_CUISINES}
            noPreferenceLabel="Surprise me"
          />

          <ChoiceGroup
            legend="What you're usually after"
            help="Ranking nudges, not filters — nothing gets hidden because of these."
            options={CONCEPT_CHOICES}
            value={draft.prefer_concepts}
            onChange={(v) => set("prefer_concepts", v)}
            noPreferenceLabel="Nothing in particular"
          />

          <p className="border-t border-line pt-6 text-base text-muted">
            An unhighlighted question is one you haven’t answered. That’s not the
            same as tapping the last chip in a row — “no preference” is a
            decision, and Discover treats it differently.
          </p>
        </div>
      )}
    </div>
  );
}
