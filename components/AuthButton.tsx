"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export default function AuthButton() {
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen]       = useState(false);
  const [mode, setMode]       = useState<"signin" | "signup">("signin");
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]     = useState("");
  const [busy, setBusy]       = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    const fn = mode === "signin"
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password });

    const { error: err } = await fn;
    setBusy(false);
    if (err) { setError(err.message); return; }
    if (mode === "signup") {
      setError("Check your email to confirm your account.");
      return;
    }
    setOpen(false);
    setEmail("");
    setPassword("");
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  if (loading) return null;

  if (user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[#8D8E89] max-w-[120px] truncate hidden sm:block">
          {user.email}
        </span>
        <button onClick={signOut} className="toolbar-btn text-[11px]">
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="toolbar-btn text-[11px]"
      >
        Sign in
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-[#1A100C] bg-[#0D1012] shadow-xl z-50 p-3"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Mode toggle */}
          <div className="flex mb-3 rounded overflow-hidden border border-[#1A100C]">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(""); }}
                className={`flex-1 text-[10px] py-1 transition-colors ${
                  mode === m
                    ? "bg-[#1A100C] text-white"
                    : "text-[#8D8E89] hover:text-white"
                }`}
              >
                {m === "signin" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="flex flex-col gap-2">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="node-input text-[11px]"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="node-input text-[11px]"
            />

            {error && (
              <p className={`text-[10px] leading-tight ${error.startsWith("Check") ? "text-[#8D8E89]" : "text-red-400"}`}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="toolbar-btn-primary text-[11px] mt-1"
            >
              {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
