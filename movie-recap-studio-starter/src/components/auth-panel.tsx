"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type AuthMode = "signin" | "signup";

export function AuthPanel() {
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);

    try {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) throw new Error("Supabase is not configured. Check your .env.local file.");

      if (mode === "signup") {
        const { data, error: authError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (authError) throw authError;
        if (data.session) {
          setMessage("Account created. Your workspace is ready.");
        } else {
          setMessage("Account created. Check your email to confirm your address, then sign in.");
          setMode("signin");
        }
      } else {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (authError) throw authError;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <a className="brand auth-brand" href="#home" aria-label="Movie Recap Studio home">
          <span className="brand-mark">M</span>
          <span className="brand-copy"><strong>movie recap</strong><small>STUDIO</small></span>
        </a>
        <div className="eyebrow">YOUR AI VIDEO WORKSPACE</div>
        <h1>{mode === "signin" ? "Welcome back." : "Create your workspace."}</h1>
        <p className="auth-subtitle">{mode === "signin" ? "Sign in to access your saved recap projects." : "Create an account to keep your projects safe and synced."}</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="field-label">Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label>
          <label className="field-label">Password<input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" minLength={8} required /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="auth-success" role="status">{message}</p>}
          <button className="primary-button auth-submit" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"} <span>→</span></button>
        </form>
        <p className="auth-switch">{mode === "signin" ? "New to Movie Recap Studio?" : "Already have an account?"} <button type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setMessage(""); }}>{mode === "signin" ? "Create account" : "Sign in"}</button></p>
        <p className="auth-footnote">Your projects are private to your account. Keep your password secure.</p>
      </section>
    </main>
  );
}
