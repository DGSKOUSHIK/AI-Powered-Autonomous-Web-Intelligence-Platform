"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    // Errors here are render failures; we don't log to any external service.
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 text-center">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/10 text-red-300">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 9v4m0 4h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-sm text-[var(--muted)]">
        An unexpected error occurred while rendering this page. Try again — your
        saved conversations are safe.
      </p>
      <div className="mt-6 flex gap-2">
        <button
          onClick={reset}
          className="press inline-flex items-center gap-2 rounded-lg bg-[var(--foreground)] px-4 py-2 text-sm font-semibold text-[var(--background)] transition hover:bg-white"
        >
          Try again
        </button>
        <button
          onClick={() => router.push("/")}
          className="press inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] transition hover:text-[var(--foreground)]"
        >
          Home
        </button>
      </div>
    </div>
  );
}