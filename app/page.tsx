"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";

/* ============ Types ============ */

type Stage = "idle" | "crawl" | "analyze" | "stream" | "done" | "error";

interface JobItem {
  title: string;
  url?: string;
  company?: string;
  location?: string;
  datePosted?: string;
  employmentType?: string;
  jobId?: string;
  salary?: string;
  source: string;
}

interface CrawledPage {
  url: string;
  title: string;
  depth: number;
  status: string;
  chars: number;
}

interface LinkPick {
  parent: string;
  picked: string[];
  reason: string;
  totalCandidates: number;
}

interface AgentMessage {
  id: string;
  role: "agent";
  url: string;
  requirement: string;
  answer: string;
  jobs: JobItem[];
  crawled: CrawledPage[];
  picks: LinkPick[];
  title: string;
  pages: number;
  contentLength: number;
  durationMs: number;
  stage: Stage;
  error?: string;
  createdAt: number;
}

interface UserMessage {
  id: string;
  role: "user";
  url: string;
  requirement: string;
  createdAt: number;
}

type Message = AgentMessage | UserMessage;

interface SessionSummary {
  _id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

/* ============ Constants ============ */

const EXAMPLES = [
  "Find new job postings",
  "Summarize what this product does",
  "Extract the pricing tiers",
  "List all features mentioned",
  "Does this page mention an API?",
  "What is the tech stack?",
  "Extract contact information",
];

/* ============ Page ============ */

export default function HomePage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState<{ id: string; username: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (!active) return;
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setUser(data.user);
        setAuthChecked(true);
      } catch {
        if (active) router.replace("/login");
      }
    })();
    return () => { active = false; };
  }, [router]);

  if (!authChecked || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="animate-spin">
            <circle cx="12" cy="12" r="9" stroke="var(--muted)" strokeWidth="2" opacity="0.2" />
            <path d="M21 12a9 9 0 00-9-9" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    );
  }

  return <App user={user} />;
}

function App({ user }: { user: { id: string; username: string } }) {
  const router = useRouter();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [view, setView] = useState<"landing" | "chat">("landing");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastUrl, setLastUrl] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    router.replace("/login");
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = () => setUserMenuOpen(false);
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [userMenuOpen]);

  // load sessions list on mount
  const refreshSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      } else {
        notify("Couldn't load history — is MongoDB running?");
      }
    } catch {
      notify("Couldn't reach the server for history.");
    }
  }, [notify]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/history");
        if (!active || !res.ok) return;
        const data = await res.json();
        if (active) setSessions(data.sessions || []);
      } catch {
        // ignore initial-load failure (toast would be noisy on first paint)
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // auto-scroll on new messages / streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages]);

  // ⌘K opens search (when in chat view)
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (view === "chat") setSearchOpen((s) => !s);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [view]);

  // Auto-collapse the sidebar on small screens so it doesn't crowd mobile.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const apply = () => setSidebarOpen(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const updateAgent = useCallback(
    (id: string, patch: Partial<AgentMessage> | ((prev: AgentMessage) => Partial<AgentMessage>)) => {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === id && msg.role === "agent"
            ? { ...(msg as AgentMessage), ...(typeof patch === "function" ? patch(msg as AgentMessage) : patch) }
            : msg,
        ),
      );
    },
    [],
  );

  const handleEvent = useCallback(
    (evt: Record<string, unknown>, agentId: string) => {
      if (evt.type === "status") {
        updateAgent(agentId, { stage: evt.stage as Stage });
      } else if (evt.type === "page") {
        updateAgent(agentId, (prev) => ({
          ...prev,
          stage: "crawl",
          crawled: [
            ...prev.crawled,
            {
              url: evt.url as string,
              title: evt.title as string,
              depth: evt.depth as number,
              status: evt.status as string,
              chars: evt.chars as number,
            },
          ],
        }));
      } else if (evt.type === "pick") {
        updateAgent(agentId, (prev) => ({
          ...prev,
          picks: [
            ...prev.picks,
            {
              parent: evt.parent as string,
              picked: evt.picked as string[],
              reason: evt.reason as string,
              totalCandidates: evt.totalCandidates as number,
            },
          ],
        }));
      } else if (evt.type === "job") {
        updateAgent(agentId, (prev) => ({
          ...prev,
          jobs: [
            ...prev.jobs,
            {
              title: (evt.job as Record<string, string>).title,
              url: (evt.job as Record<string, string>).url,
              company: (evt.job as Record<string, string>).company,
              location: (evt.job as Record<string, string>).location,
              datePosted: (evt.job as Record<string, string>).datePosted,
              employmentType: (evt.job as Record<string, string>).employmentType,
              jobId: (evt.job as Record<string, string>).jobId,
              salary: (evt.job as Record<string, string>).salary,
              source: (evt.job as Record<string, string>).source || (evt.source as string),
            },
          ],
        }));
      } else if (evt.type === "token") {
        updateAgent(agentId, (prev) => ({
          ...prev,
          stage: "stream",
          answer: prev.answer + (evt.delta as string),
        }));
      } else if (evt.type === "done") {
        updateAgent(agentId, {
          stage: "done",
          title: evt.title as string,
          pages: evt.pages as number,
          contentLength: evt.contentLength as number,
        });
      } else if (evt.type === "error") {
        updateAgent(agentId, { stage: "error", error: evt.message as string });
      }
    },
    [updateAgent],
  );

  const startAnalysis = useCallback(
    async (url: string, requirement: string) => {
      const resolvedUrl = url.trim() || lastUrl;
      if (!resolvedUrl.trim() || !requirement.trim() || busy) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLastUrl(resolvedUrl);

      // create session if needed
      let sid = sessionId;
      if (!sid) {
        try {
          const r = await fetch("/api/history", { method: "POST" });
          if (r.ok) {
            const d = await r.json();
            sid = d.id;
            setSessionId(sid);
          }
        } catch {
          // proceed without persistence
        }
      }

      const userMsg: UserMessage = {
        id: crypto.randomUUID(),
        role: "user",
        url: resolvedUrl,
        requirement,
        createdAt: Date.now(),
      };
      const agentId = crypto.randomUUID();
      const agentMsg: AgentMessage = {
        id: agentId,
        role: "agent",
        url: resolvedUrl,
        requirement,
        answer: "",
        jobs: [],
        crawled: [],
        picks: [],
        title: "",
        pages: 0,
        contentLength: 0,
        durationMs: 0,
        stage: "crawl",
        createdAt: Date.now(),
      };

      setMessages((m) => [...m, userMsg, agentMsg]);
      setView("chat");
      setBusy(true);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: resolvedUrl, requirement, sessionId: sid }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const txt = await res.text().catch(() => "");
          updateAgent(agentId, {
            stage: "error",
            error: `Request failed (${res.status}): ${txt || res.statusText}`,
          });
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const evt = JSON.parse(line);
              handleEvent(evt, agentId);
            } catch {
              // partial
            }
          }
        }
        updateAgent(agentId, (prev) => ({
          ...prev,
          stage: prev.stage === "error" ? "error" : "done",
          durationMs: Date.now() - agentMsg.createdAt,
        }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        updateAgent(agentId, {
          stage: "error",
          error: (err as Error).message,
        });
      } finally {
        setBusy(false);
        refreshSessions();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, busy, lastUrl],
  );

  const loadSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/history/${id}`);
      if (!res.ok) {
        notify("Couldn't load that session (it may have been deleted).");
        return;
      }
      const data = await res.json();
      const s = data.session;
      if (!s) return;
      setSessionId(s._id);
      const msgs: Message[] = (s.messages || []).map((m: Record<string, unknown>) => {
        const base = {
          id: (m.id as string) || crypto.randomUUID(),
          createdAt: m.createdAt ? new Date(m.createdAt as string).getTime() : Date.now(),
        };
        if (m.role === "user") {
          return {
            ...base,
            role: "user",
            url: (m.url as string) || "",
            requirement: (m.requirement as string) || "",
          } as UserMessage;
        }
        return {
          ...base,
          role: "agent",
          url: (m.url as string) || "",
          requirement: (m.requirement as string) || "",
          answer: (m.answer as string) || "",
          jobs: (m.jobs as JobItem[]) || [],
          crawled: (m.crawled as CrawledPage[]) || [],
          picks: (m.picks as LinkPick[]) || [],
          title: (m.title as string) || "",
          pages: (m.pages as number) || 0,
          contentLength: (m.contentLength as number) || 0,
          durationMs: (m.durationMs as number) || 0,
          stage: "done" as Stage,
          error: m.error as string | undefined,
        } as AgentMessage;
      });
      setMessages(msgs);
      const lastWithUrl = [...msgs].reverse().find((m) => m.url && m.url.trim());
      if (lastWithUrl) setLastUrl(lastWithUrl.url);
      setView("chat");
    } catch {
      notify("Couldn't load that session.");
    }
  }, [notify]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setSessionId(null);
    setView("landing");
  }, []);

  const deleteSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
        if (!res.ok) {
          notify("Couldn't delete that session.");
          return;
        }
        if (sessionId === id) newChat();
        refreshSessions();
      } catch {
        notify("Couldn't reach the server to delete.");
      }
    },
    [sessionId, newChat, refreshSessions, notify],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Sidebar */}
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        sessions={sessions}
        activeId={sessionId}
        onSelect={(id) => {
          loadSession(id);
          if (window.matchMedia("(max-width: 768px)").matches) setSidebarOpen(false);
        }}
        onNew={newChat}
        onDelete={deleteSession}
      />

      {/* Main */}
      <main className="relative flex flex-1 flex-col">
        {/* Top bar */}
        <header className="z-10 flex items-center justify-between border-b border-[var(--border)] bg-[var(--background)]/70 px-4 py-2.5 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((o) => !o)}
              className="press rounded-lg border border-[var(--border)] p-1.5 text-[var(--muted)] transition hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
              aria-label="Toggle sidebar"
            >
              <MenuIcon />
            </button>
            <Logo />
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold tracking-tight">
                Web Intel
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge label="gemma4:e2b" />
            <button
              onClick={newChat}
              aria-label="New chat"
              className="press inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs text-[var(--muted)] transition hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
            >
              <PlusIcon /> New
            </button>
            {user && (
              <div className="relative" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => setUserMenuOpen((o) => !o)}
                  className="press flex items-center gap-2 rounded-lg border border-[var(--border)] px-2 py-1.5 text-xs text-[var(--muted)] transition hover:text-[var(--foreground)] hover:bg-[var(--surface-hover)]"
                  aria-label="User menu"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[10px] font-semibold uppercase text-[var(--accent)]">
                    {user.username.charAt(0)}
                  </span>
                  <span className="hidden max-w-20 truncate sm:inline">{user.username}</span>
                </button>
                <AnimatePresence>
                  {userMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--background-elevated)] shadow-xl"
                    >
                      <div className="border-b border-[var(--border)] px-3 py-2.5">
                        <p className="truncate text-xs font-medium text-[var(--foreground)]">{user.username}</p>
                        <p className="text-[10px] text-[var(--faint)]">Signed in</p>
                      </div>
                      <button
                        onClick={logout}
                        className="press flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-[var(--muted)] transition hover:bg-[var(--surface-hover)] hover:text-red-300"
                      >
                        <LogoutIcon /> Sign out
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        </header>

        {/* Body */}
        {view === "landing" ? (
          <LandingHero onStart={startAnalysis} busy={busy} />
        ) : (
          <ChatView
            messages={messages}
            busy={busy}
            scrollRef={scrollRef}
            onSend={startAnalysis}
            onCancel={() => abortRef.current?.abort()}
            searchOpen={searchOpen}
            onSearchOpenChange={setSearchOpen}
            lastUrl={lastUrl}
          />
        )}
      </main>

      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.96 }}
            transition={{ duration: 0.2 }}
            className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-[var(--border-strong)] bg-[var(--background-elevated)] px-4 py-2.5 text-sm text-[var(--foreground)] shadow-xl"
            role="status"
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ============ Sidebar ============ */

function Sidebar({
  open,
  onToggle,
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  open: boolean;
  onToggle: () => void;
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.aside
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 272, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="absolute inset-y-0 left-0 z-30 w-[272px] overflow-hidden border-r border-[var(--border)] bg-[var(--background-elevated)]/95 backdrop-blur-xl sm:relative sm:z-20 sm:bg-[var(--background-elevated)]/60"
          aria-label="Conversation history"
        >
          <div className="flex h-full w-[272px] flex-col">
            <div className="p-3">
              <button
                onClick={onNew}
                className="press flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--foreground)] px-4 py-2 text-[13px] font-semibold text-[var(--background)] transition hover:bg-white"
              >
                <PlusIcon /> New analysis
              </button>
            </div>
            <div className="px-4 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--faint)]">
              History
            </div>
            <div className="chat-scroll flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
              {sessions.length === 0 && (
                <p className="px-2 py-6 text-center text-xs text-[var(--faint)]">
                  No analyses yet.
                </p>
              )}
              <AnimatePresence initial={false}>
                {sessions.map((s) => (
                  <motion.div
                    key={s._id}
                    layout
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(s._id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(s._id);
                      }
                    }}
                    className={[
                      "group flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]",
                      activeId === s._id
                        ? "border-[var(--accent-ring)] bg-[var(--accent-soft)]"
                        : "border-transparent hover:bg-[var(--surface-hover)]",
                    ].join(" ")}
                  >
                    <div className="mt-0.5 text-[var(--muted)]">
                      <HistoryIcon />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-[var(--foreground)]">{s.title}</p>
                      <p className="text-[10px] text-[var(--faint)]">
                        {new Date(s.updatedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        · {s.messageCount} msg
                      </p>
                    </div>
                    <button
                      onClick={(e) => onDelete(s._id, e)}
                      className="text-[var(--faint)] opacity-0 transition hover:text-red-300 group-hover:opacity-100"
                      aria-label="Delete"
                    >
                      <TrashIcon />
                    </button>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
            <div className="border-t border-[var(--border)] px-4 py-2.5 text-[10px] text-[var(--faint)]">
              Sessions stored in MongoDB
            </div>
          </div>
          <button
            onClick={onToggle}
            className="press absolute -right-3 top-1/2 z-30 hidden -translate-y-1/2 rounded-full border border-[var(--border)] bg-[var(--background-elevated)] p-1 text-[var(--muted)] transition hover:text-[var(--foreground)] sm:block"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft />
          </button>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* ============ Landing ============ */

function LandingHero({
  onStart,
  busy,
}: {
  onStart: (url: string, requirement: string) => void;
  busy: boolean;
}) {
  const [url, setUrl] = useState("");
  const [requirement, setRequirement] = useState("");

  return (
    <div className="chat-scroll flex flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-10">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-xl text-center"
      >
        <motion.span
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[11px] font-medium tracking-wide text-[var(--muted-strong)]"
        >
          <span className="pulse-dot text-[var(--accent-2)]" />
          Autonomous agent · live
        </motion.span>
        <h1 className="mt-6 text-balance text-[2.5rem] font-semibold leading-[1.08] tracking-tight sm:text-5xl">
          <span className="text-[var(--foreground)]">Chat with the web.</span>
          <br />
          <span className="text-[var(--muted)]">Get answers, not pages.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-[var(--muted)]">
          Paste a URL and describe what you need. The agent crawls, reasons, and
          answers — with citations and history.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.15 }}
        className="glass focus-ring mt-9 w-full max-w-xl rounded-2xl p-5 sm:p-6"
      >
        <Field
          label="Website URL"
          icon={<LinkIcon />}
          value={url}
          onChange={setUrl}
          placeholder="https://example.com"
          disabled={busy}
          onSubmit={() => onStart(url, requirement)}
        />
        <div className="mt-4">
          <Field
            label="What do you want to know?"
            icon={<SparkIcon />}
            value={requirement}
            onChange={setRequirement}
            placeholder="Describe your goal — find job postings, extract pricing, summarize features…"
            disabled={busy}
            multiline
            onSubmit={() => onStart(url, requirement)}
          />
          <div className="mt-3 flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={busy}
                onClick={() => setRequirement(ex)}
                className="press rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs text-[var(--muted)] transition hover:border-[var(--accent-ring)] hover:text-[var(--foreground)] disabled:opacity-40"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            onClick={() => onStart(url, requirement)}
            disabled={!url.trim() || !requirement.trim() || busy}
            className="press group inline-flex items-center gap-2 rounded-lg bg-[var(--foreground)] px-5 py-2.5 text-sm font-semibold text-[var(--background)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            <BoltIcon /> Analyze
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ============ Chat View ============ */

function ChatView({
  messages,
  busy,
  scrollRef,
  onSend,
  onCancel,
  searchOpen,
  onSearchOpenChange,
  lastUrl,
}: {
  messages: Message[];
  busy: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onSend: (url: string, requirement: string) => void;
  onCancel: () => void;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  lastUrl: string;
}) {
  const [query, setQuery] = useState("");

  // search across all agent answers
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { messageId: string; snippet: string; index: number }[] = [];
    for (const m of messages) {
      if (m.role !== "agent" || !m.answer) continue;
      const lower = m.answer.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(m.answer.length, idx + q.length + 40);
        const snippet =
          (start > 0 ? "…" : "") +
          m.answer.slice(start, end).replace(/\n/g, " ") +
          (end < m.answer.length ? "…" : "");
        out.push({ messageId: m.id, snippet, index: idx });
        idx = lower.indexOf(q, idx + q.length);
      }
    }
    return out;
  }, [messages, query]);

  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("search-flash");
      setTimeout(() => el.classList.remove("search-flash"), 1400);
    }
  }, []);

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Search bar */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-[var(--border)] bg-[var(--background-elevated)]/60"
          >
            <div className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-2.5 sm:px-6">
              <SearchIcon />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search across all answers…"
                aria-label="Search answers"
                className="flex-1 bg-transparent text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none"
              />
              {query.trim() && (
                <span className="shrink-0 rounded-md bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--muted)]">
                  {searchResults.length} {searchResults.length === 1 ? "hit" : "hits"}
                </span>
              )}
              <button
                onClick={() => {
                  setQuery("");
                  onSearchOpenChange(false);
                }}
                className="press shrink-0 rounded-md p-1 text-[var(--muted)] transition hover:text-[var(--foreground)]"
                aria-label="Close search"
              >
                <CloseIcon />
              </button>
            </div>
            {query.trim() && searchResults.length === 0 && (
              <div className="border-t border-[var(--border)] px-4 py-3 text-center text-xs text-[var(--faint)] sm:px-6">
                No answers match &ldquo;{query.trim()}&rdquo;
              </div>
            )}
            {query.trim() && searchResults.length > 0 && (
              <div className="chat-scroll max-h-48 overflow-y-auto border-t border-[var(--border)]">
                <div className="mx-auto max-w-3xl px-4 py-1.5 sm:px-6">
                  {searchResults.slice(0, 12).map((r, i) => (
                    <button
                      key={`${r.messageId}-${r.index}-${i}`}
                      onClick={() => scrollToMessage(r.messageId)}
                      className="press group block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-[var(--muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"
                    >
                      <Highlight text={r.snippet} q={query.trim()} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div ref={scrollRef} className="chat-scroll flex-1 overflow-y-auto" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-24 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--surface)] border border-[var(--border)] text-[var(--accent)]">
              <AgentIcon />
            </div>
            <h2 className="text-lg font-semibold text-[var(--foreground)]">This conversation is empty</h2>
            <p className="mt-1.5 text-sm text-[var(--muted)]">
              Type a question below to start analyzing a site. The agent will crawl, reason, and answer here.
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
            <AnimatePresence initial={false}>
              {messages.map((m) =>
                m.role === "user" ? (
                  <UserBubble key={m.id} msg={m} />
                ) : (
                  <AgentBubble key={m.id} msg={m} />
                ),
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Floating search trigger */}
      <AnimatePresence>
        {!searchOpen && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.18 }}
            onClick={() => onSearchOpenChange(true)}
            className="press absolute bottom-24 right-5 z-10 flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--background-elevated)]/80 px-3 py-2 text-xs text-[var(--muted)] shadow-lg backdrop-blur-xl transition hover:text-[var(--foreground)] sm:right-6"
            aria-label="Search answers"
          >
            <SearchIcon /> <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[9px] font-mono text-[var(--faint)] sm:inline">⌘K</kbd>
          </motion.button>
        )}
      </AnimatePresence>

      <ChatComposer disabled={busy} onSend={onSend} onCancel={onCancel} busy={busy} lastUrl={lastUrl} />
    </div>
  );
}

/* ============ Highlight helper ============ */

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const lq = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const found = lower.indexOf(lq, i);
    if (found === -1) {
      parts.push(<span key={key++}>{text.slice(i)}</span>);
      break;
    }
    if (found > i) parts.push(<span key={key++}>{text.slice(i, found)}</span>);
    parts.push(
      <mark key={key++} className="rounded bg-[var(--accent-soft)] px-0.5 text-[var(--foreground)]">
        {text.slice(found, found + q.length)}
      </mark>,
    );
    i = found + q.length;
  }
  return <>{parts}</>;
}

/* ============ Bubbles ============ */

function UserBubble({ msg }: { msg: UserMessage }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="flex justify-end"
    >
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-[var(--accent-ring)] bg-[var(--accent-soft)] px-4 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-[var(--accent)]">
          <LinkIcon /> {shortHost(msg.url)}
        </div>
        <p className="text-sm leading-relaxed text-[var(--foreground)]">{msg.requirement}</p>
      </div>
    </motion.div>
  );
}

function AgentBubble({ msg }: { msg: AgentMessage }) {
  const streaming = msg.stage === "stream" || msg.stage === "crawl" || msg.stage === "analyze";
  const done = msg.stage === "done";
  const [copied, setCopied] = useState(false);

  const copyAnswer = useCallback(() => {
    if (!msg.answer) return;
    navigator.clipboard.writeText(msg.answer).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [msg.answer]);

  return (
    <motion.div
      layout
      id={`msg-${msg.id}`}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="flex justify-start"
    >
      <div className="flex w-full max-w-[92%] gap-3">
        <motion.div
          animate={streaming ? { scale: [1, 1.08, 1] } : { scale: 1 }}
          transition={streaming ? { duration: 2, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--surface)] border border-[var(--border)]"
        >
          <AgentIcon />
        </motion.div>
        <div className="min-w-0 flex-1 space-y-3">
          {/* Thinking / progress */}
          {streaming && (msg.answer?.length ?? 0) === 0 && (msg.jobs?.length ?? 0) === 0 && (
            <ThinkingBubble stage={msg.stage} />
          )}

          {/* Crawl summary chips */}
          {(msg.crawled?.length ?? 0) > 0 && (
            <CrawlChips pages={msg.crawled ?? []} picks={msg.picks ?? []} active={msg.stage === "crawl"} />
          )}

          {/* Job cards */}
          {(msg.jobs?.length ?? 0) > 0 && (
            <JobCardGrid jobs={msg.jobs ?? []} />
          )}

          {/* Answer markdown */}
          {(msg.answer?.length ?? 0) > 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25 }}
              className="glass rounded-2xl rounded-tl-md px-4 py-3"
            >
              <div
                className="prose-answer text-sm"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(msg.answer ?? "") + (msg.stage === "stream" ? '<span class="caret"></span>' : ""),
                }}
              />
            </motion.div>
          )}

          {/* Error */}
          {msg.stage === "error" && msg.error && (
            <motion.div
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              className="rounded-xl border border-red-500/25 bg-red-500/[0.07] px-4 py-3 text-sm text-red-200"
            >
              {msg.error}
            </motion.div>
          )}

          {/* Footer meta + actions */}
          {done && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.05 }}
              className="flex flex-wrap items-center gap-2.5 px-1 text-[10px] text-[var(--faint)]"
            >
              <a
                href={msg.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 truncate transition hover:text-[var(--foreground)]"
              >
                <LinkIcon /> {shortHost(msg.url)}
              </a>
              {msg.pages > 0 && <span>· {msg.pages} pages</span>}
              {msg.contentLength > 0 && <span>· {msg.contentLength.toLocaleString()} chars</span>}
              {msg.jobs.length > 0 && <span className="text-[var(--accent-2)]">· {msg.jobs.length} jobs</span>}
              {msg.durationMs > 0 && <span className="font-mono tabular-nums">{(msg.durationMs / 1000).toFixed(1)}s</span>}
              {msg.answer && (
                <button
                  onClick={copyAnswer}
                  className="press ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted)] transition hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
                >
                  {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
                </button>
              )}
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function ThinkingBubble({ stage }: { stage: Stage }) {
  const steps = [
    { key: "crawl", label: "Crawling the site…" },
    { key: "analyze", label: "Preparing context…" },
    { key: "stream", label: "Reasoning over the pages…" },
  ];
  const activeIdx = steps.findIndex((s) => s.key === stage);
  const label = activeIdx >= 0 ? steps[activeIdx].label : "Working…";
  return (
    <div className="glass inline-flex items-center gap-3 rounded-2xl rounded-tl-md px-4 py-3">
      <div className="flex gap-1">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
      <span className="shimmer-text text-sm font-medium">{label}</span>
    </div>
  );
}

/* ============ Crawl chips ============ */

function CrawlChips({
  pages,
  picks,
  active,
}: {
  pages: CrawledPage[];
  picks: LinkPick[];
  active: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? pages : pages.slice(0, 6);
  const okCount = pages.filter((p) => p.status === "ok").length;
  const errCount = pages.filter((p) => p.status === "error").length;
  return (
    <div className="glass overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
            Crawl
          </span>
          <span className="font-mono tabular-nums">
            {okCount} ok · {errCount} err · {pages.length} pages
          </span>
        </span>
        {active && (
          <span className="flex items-center gap-1.5 text-[10px] text-[var(--accent-2)]">
            <Spinner size={9} /> live
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 p-2.5">
        <AnimatePresence>
          {visible.map((p, i) => (
            <motion.span
              key={p.url + i}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="crawl-chip inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px]"
              title={p.url}
            >
              <span
                className={[
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  p.status === "ok"
                    ? "bg-[var(--accent-2)]"
                    : p.status === "error"
                      ? "bg-red-400"
                      : "bg-white/20",
                ].join(" ")}
              />
              <span className="truncate text-[var(--muted-strong)]">{p.title || shortHost(p.url)}</span>
              <span className="text-[var(--faint)]">d{p.depth}</span>
            </motion.span>
          ))}
        </AnimatePresence>
        {pages.length > 6 && (
          <button
            onClick={() => setShowAll((s) => !s)}
            className="press rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--muted)] transition hover:text-[var(--foreground)]"
          >
            {showAll ? "less" : `+${pages.length - 6} more`}
          </button>
        )}
      </div>
      {picks.length > 0 && active && picks.slice(-1)[0] && (
        <div className="border-t border-[var(--border)] px-3 py-1.5 text-[10px] text-[var(--faint)]">
          <span className="text-[var(--accent)]">LLM picked</span> {picks.slice(-1)[0].picked.length}/
          {picks.slice(-1)[0].totalCandidates} links — {picks.slice(-1)[0].reason.slice(0, 80)}
        </div>
      )}
    </div>
  );
}

/* ============ Job cards ============ */

function JobCardGrid({ jobs }: { jobs: JobItem[] }) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        (j.location || "").toLowerCase().includes(q) ||
        (j.company || "").toLowerCase().includes(q),
    );
  }, [jobs, query]);
  const visible = showAll ? filtered : filtered.slice(0, 8);

  return (
    <div className="glass overflow-hidden rounded-2xl">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <span className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          <span className="rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
            Jobs
          </span>
          <span className="font-mono tabular-nums">
            {jobs.length} detected{filtered.length !== jobs.length && ` · ${filtered.length} shown`}
          </span>
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          className="w-32 rounded-md border border-[var(--border)] bg-black/20 px-2 py-1 text-[10px] text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none transition focus:border-[var(--accent-ring)]"
        />
      </div>
      <div className="grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-2">
        <AnimatePresence>
          {visible.map((j, i) => (
            <JobCardMini key={i} job={j} />
          ))}
        </AnimatePresence>
      </div>
      {filtered.length > 8 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="press w-full border-t border-[var(--border)] py-2 text-[11px] text-[var(--muted)] transition hover:text-[var(--foreground)]"
        >
          {showAll ? "Show less" : `Show all ${filtered.length} jobs`}
        </button>
      )}
      {filtered.length === 0 && (
        <p className="py-6 text-center text-xs text-[var(--faint)]">
          No jobs match &ldquo;{query}&rdquo;
        </p>
      )}
    </div>
  );
}

function JobCardMini({ job }: { job: JobItem }) {
  const content = (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2 }}
      className="job-card-mini flex flex-col gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <BriefcaseIcon />
        </div>
        <h4 className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--foreground)]">
          {job.title}
        </h4>
      </div>
      {job.location && (
        <div className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
          <PinIcon /> <span className="truncate">{job.location}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
        {job.datePosted && (
          <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[var(--accent)]">
            {job.datePosted}
          </span>
        )}
        {job.employmentType && (
          <span className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-[var(--muted-strong)]">
            {job.employmentType}
          </span>
        )}
        {job.jobId && (
          <span className="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 font-mono text-[var(--faint)]">
            #{String(job.jobId).slice(-6)}
          </span>
        )}
      </div>
    </motion.div>
  );
  return job.url ? (
    <a href={job.url} target="_blank" rel="noreferrer" className="block">
      {content}
    </a>
  ) : (
    content
  );
}

/* ============ Composer ============ */

function ChatComposer({
  disabled,
  onSend,
  onCancel,
  busy,
  lastUrl,
}: {
  disabled: boolean;
  onSend: (url: string, requirement: string) => void;
  onCancel: () => void;
  busy: boolean;
  lastUrl: string;
}) {
  const [url, setUrl] = useState("");
  const [requirement, setRequirement] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hasFallback = !!lastUrl.trim();

  const submit = () => {
    const finalUrl = url.trim() || (hasFallback ? lastUrl : "");
    if (!finalUrl.trim() || !requirement.trim() || disabled) return;
    onSend(finalUrl, requirement);
    setUrl("");
    setRequirement("");
  };

  return (
    <div className="border-t border-[var(--border)] bg-[var(--background)]/70 px-4 py-3 backdrop-blur-xl sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="glass focus-ring rounded-2xl p-2">
          <div className="flex flex-wrap items-center gap-2 px-2 sm:flex-nowrap">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={hasFallback ? `URL (optional · last: ${shortHost(lastUrl)})` : "URL (https://example.com)"}
              aria-label="Website URL"
              className="w-full bg-transparent text-xs text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none sm:w-52 sm:shrink-0 lg:w-64"
            />
            <div className="hidden h-4 w-px bg-[var(--border)] sm:block" />
            <textarea
              ref={inputRef}
              value={requirement}
              onChange={(e) => setRequirement(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={hasFallback ? "Ask a follow-up about the same site… (⌘+Enter to send)" : "Ask the agent to analyze the site… (⌘+Enter to send)"}
              aria-label="Your question"
              rows={1}
              className="order-last w-full flex-1 resize-none bg-transparent py-1 text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none sm:order-none"
            />
            {busy ? (
              <button
                onClick={onCancel}
                className="press shrink-0 rounded-xl border border-[var(--border)] px-3 py-2 text-xs text-[var(--foreground)] transition hover:bg-[var(--surface-hover)]"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={(!url.trim() && !hasFallback) || !requirement.trim()}
                className="press shrink-0 rounded-xl bg-[var(--foreground)] p-2 text-[var(--background)] transition hover:bg-white disabled:opacity-40"
                aria-label="Send"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-[var(--faint)]">
          {hasFallback
            ? <>Leave URL empty to reuse <span className="text-[var(--muted)]">{shortHost(lastUrl)}</span>. The agent stores every message in MongoDB.</>
            : "The agent crawls, reasons, and stores the conversation in MongoDB."}
        </p>
      </div>
    </div>
  );
}

/* ============ Input field (landing) ============ */

function Field({
  label,
  icon,
  value,
  onChange,
  placeholder,
  disabled,
  multiline,
  onSubmit,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  disabled?: boolean;
  multiline?: boolean;
  onSubmit?: () => void;
}) {
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (multiline ? e.metaKey || e.ctrlKey : true)) {
      e.preventDefault();
      onSubmit?.();
    }
  };
  const fieldId = `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">
        <span className="text-[var(--accent)]">{icon}</span>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          className="focus-ring w-full resize-none rounded-xl border border-[var(--border)] bg-black/20 px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none transition disabled:opacity-50"
        />
      ) : (
        <input
          id={fieldId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          disabled={disabled}
          className="focus-ring w-full rounded-xl border border-[var(--border)] bg-black/20 px-4 py-3 text-sm text-[var(--foreground)] placeholder:text-[var(--faint)] outline-none transition disabled:opacity-50"
        />
      )}
    </div>
  );
}

/* ============ Helpers ============ */

function shortHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function inline(s: string) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return out;
}
function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const html: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeTable = () => {
    if (html[html.length - 1] === "</tbody></table>") return;
    if (html.length && html[html.length - 1].includes("<table")) {
      html.push("</tbody></table>");
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        closeTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeList();
      closeTable();
      html.push('<hr class="my-3 border-white/10" />');
      continue;
    }

    // headings (also support bold-as-heading)
    if (/^#{1,4}\s/.test(line)) {
      closeList();
      closeTable();
      const level = Math.min(line.match(/^#+/)![0].length, 4);
      html.push(`<h${level}>${inline(line.replace(/^#+\s/, ""))}</h${level}>`);
      continue;
    }

    // table: header row + separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      closeList();
      // close prior table if open
      if (!html.length || !html[html.length - 1].includes("<table")) {
        closeTable();
        html.push('<table class="md-table">');
      }
      const headerCells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      html.push("<thead><tr>" + headerCells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>");
      i++; // skip separator
      // body rows
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
        i++;
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        html.push("<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      html.push("</tbody></table>");
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      closeTable();
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      closeTable();
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      continue;
    }
    // blockquote
    if (line.trim().startsWith("> ")) {
      closeList();
      closeTable();
      html.push(`<blockquote>${inline(line.replace(/^>\s/, ""))}</blockquote>`);
      continue;
    }
    // blank
    if (line.trim() === "") {
      closeList();
      closeTable();
      continue;
    }
    closeList();
    closeTable();
    html.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) html.push("<pre><code>" + escapeHtml(codeBuf.join("\n")) + "</code></pre>");
  closeList();
  closeTable();
  return html.join("\n");
}

/* ============ Icons ============ */

function Logo() {
  return (
    <div className="relative flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--surface)] border border-[var(--border)]">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7v6c0 5 3.5 8 9 9 5.5-1 9-4 9-9V7l-9-5z" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M9 12l2 2 4-4" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
  );
}
function PlusIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>);
}
function ChevronLeft() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function HistoryIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 12a9 9 0 109-9 9 9 0 00-7 3.5L3 9m0-5v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>);
}
function TrashIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function LinkIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function SparkIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>);
}
function BoltIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11l-1 8.5L19.5 10H13l0-8z" /></svg>);
}
function AgentIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4" y="6" width="16" height="13" rx="3" stroke="white" strokeWidth="1.6" /><path d="M12 6V3M9 13h.01M15 13h.01" stroke="white" strokeWidth="1.6" strokeLinecap="round" /><path d="M2 12v2M22 12v2" stroke="white" strokeWidth="1.6" strokeLinecap="round" /></svg>);
}
function SendIcon() {
  return (<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 16-3-7-7-1z" stroke="white" strokeWidth="1.6" strokeLinejoin="round" fill="currentColor" fillOpacity="0.2" /></svg>);
}
function Spinner({ size = 14 }: { size?: number }) {
  return (<svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" /><path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>);
}
function BriefcaseIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 12h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>);
}
function PinIcon() {
  return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 21s-7-6.5-7-11a7 7 0 1114 0c0 4.5-7 11-7 11z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.8" /></svg>);
}
function Badge({ label }: { label: string }) {
  return (<span className="hidden items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] text-[var(--muted)] sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />{label}</span>);
}
function SearchIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>);
}
function CloseIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>);
}
function CopyIcon() {
  return (<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M5 15V5a2 2 0 012-2h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>);
}
function CheckIcon() {
  return (<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function LogoutIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}