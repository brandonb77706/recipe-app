"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Sign-in only — there is no sign-up form on purpose. Signups are disabled in
 * the Supabase dashboard and accounts are created by hand, which is the
 * simplest control that can't leak: there's no invite code to lose.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      // Deliberately not distinguishing "no such account" from "wrong
      // password" — that difference tells an attacker which emails exist.
      setError("That email and password didn't match.");
      setBusy(false);
      return;
    }

    // Full navigation so the proxy sees the new cookies on the next request.
    router.replace(next);
    router.refresh();
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight">
        Recipe Vault
      </h1>
      <p className="mt-2 text-base text-muted">Sign in to your kitchen.</p>

      <form onSubmit={submit} className="mt-8 space-y-3">
        <input
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Email"
          className="h-13 w-full rounded-[var(--radius-control)] border border-line bg-surface px-4 text-base outline-none transition placeholder:text-muted/70 focus:border-accent"
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          className="h-13 w-full rounded-[var(--radius-control)] border border-line bg-surface px-4 text-base outline-none transition placeholder:text-muted/70 focus:border-accent"
        />

        <button
          type="submit"
          disabled={busy || !email.trim() || !password}
          className="h-13 w-full rounded-[var(--radius-control)] bg-accent text-base font-semibold text-white transition active:opacity-90 disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error && <p className="mt-4 text-base text-accent">{error}</p>}
    </div>
  );
}

export default function Login() {
  // useSearchParams needs a Suspense boundary to avoid opting the whole route
  // into client-side rendering.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
