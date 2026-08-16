"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Debounced search input. Owns its own text state so typing stays responsive,
 * and only tells the parent once you've stopped — the parent owns the results.
 */
export function SearchBar({
  initialValue = "",
  onChange,
  placeholder = "Search recipes",
  busy = false,
}: {
  initialValue?: string;
  onChange: (next: string) => void;
  placeholder?: string;
  busy?: boolean;
}) {
  // The input owns its text outright. Mirroring a parent value back into it
  // would mean a setState inside an effect on every keystroke round-trip, and
  // the only reset path — the clear button — is right here anyway.
  const [text, setText] = useState(initialValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const push = (next: string) => {
    setText(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next.trim()), 250);
  };

  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-muted"
      >
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M20 20l-3.5-3.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>

      <input
        // type="text", not "search": WebKit draws its own clear button inside
        // a search input, which sat on top of ours. inputMode is what gives
        // the mobile keyboard a search key, and it's independent of type.
        type="text"
        inputMode="search"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        onChange={(e) => push(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-13 w-full rounded-2xl border border-line bg-surface pr-12 pl-12 text-base outline-none transition placeholder:text-muted/70 focus:border-accent"
      />

      {text.length > 0 && (
        <button
          type="button"
          onClick={() => {
            if (timer.current) clearTimeout(timer.current);
            setText("");
            onChange("");
          }}
          aria-label="Clear search"
          className="absolute top-1/2 right-3 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted transition active:bg-accent-soft"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}

      {busy && text.length > 0 && (
        <span className="sr-only" role="status">
          Searching
        </span>
      )}
    </div>
  );
}
