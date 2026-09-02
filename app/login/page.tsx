"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!username.trim() || !password.trim() || busy) return;
      setBusy(true);
      setError("");
      try {
        const res = await fetch(`/api/auth/${mode}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: username.trim(), password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Something went wrong");
          return;
        }
        router.push("/");
        router.refresh();
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [mode, username, password, busy, router],
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L3 7v6c0 5 3.5 8 9 9 5.5-1 9-4 9-9V7l-9-5z" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M9 12l2 2 4-4" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--foreground)]">Web Intel</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">Autonomous Web Intelligence</p>
        </div>

        <div className="glass focus-ring rounded-2xl p-6">
          <div className="mb-5 flex rounded-lg border border-[var(--border)] p-1">
            <button
              type="button"
              onClick={() => { setMode("login"); setError(""); }}
              className={`press flex-1 rounded-md py-1.5 text-xs font-medium transition ${
                mode === "login"
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode("register"); setError(""); }}
              className={`press flex-1 rounded-md py-1.5 text-xs font-medium transition ${
                mode === "register"
                  ? "bg-[var(--foreground)] text-[var(--background)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              Create account
            </button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label htmlFor="login-username" className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Username
              </label>
              <input
                id="login-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Choose a username"
                autoComplete="username"
                autoFocus
                className="focus-ring w-full rounded-xl border border-[var(--border)] bg-black/20 px-4 py-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none transition"
              />
            </div>
            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className="focus-ring w-full rounded-xl border border-[var(--border)] bg-black/20 px-4 py-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none transition"
              />
            </div>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="rounded-lg border border-red-500/25 bg-red-500/[0.07] px-3 py-2 text-xs text-red-300"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={busy || !username.trim() || !password.trim()}
              className="press w-full rounded-xl bg-[var(--foreground)] py-2.5 text-sm font-semibold text-[var(--background)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-[10px] text-[var(--faint)]">
          {mode === "register" ? "Min 3 chars username · Min 6 chars password" : "Your account is stored locally in MongoDB."}
        </p>
      </motion.div>
    </div>
  );
}