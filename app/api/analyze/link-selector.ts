const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e2b";

export interface LinkCandidate {
  url: string;
  anchor: string;
}

export interface LinkSelectionResult {
  picked: string[];
  reason: string;
}

export async function selectLinks(
  requirement: string,
  pageUrl: string,
  pageTitle: string,
  candidates: LinkCandidate[],
  maxPick: number,
): Promise<LinkSelectionResult> {
  if (candidates.length === 0) return { picked: [], reason: "no links found" };
  if (candidates.length <= maxPick) {
    return {
      picked: candidates.map((c) => c.url),
      reason: "few links; following all",
    };
  }

  const isJobQuery = /\b(job|jobs|hiring|career|careers|opening|openings|position|vacanc|recruit|join us|work with us)\b/i.test(
    requirement,
  );

  // Pre-filter: drop obviously-irrelevant links to reduce LLM load.
  const skipPatterns = /^(login|sign[- ]?up|sign[- ]?in|register|cart|checkout|account|auth|oauth|privacy|terms|legal|cookie|social|facebook|twitter|linkedin|instagram|youtube|github\.com\/login|mailto:)/i;
  const filtered = candidates.filter(
    (c) =>
      !skipPatterns.test(c.url) &&
      !skipPatterns.test(c.anchor) &&
      !/\.(png|jpg|jpeg|gif|svg|css|js|pdf|zip|woff2?)$/i.test(c.url),
  );

  // Keyword-based heuristic fallback: score links by requirement keywords
  // matching against anchor + URL path. Used if the LLM fails/times out.
  const heuristicPick = (pool: LinkCandidate[], n: number): LinkCandidate[] => {
    const stopwords = new Set([
      "the","a","an","and","or","of","to","in","on","for","what","is","are","with","this","that","site","page","website","find","list","extract","get","show","tell","me","about","does","mention","have","their",
    ]);
    const keywords = requirement
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !stopwords.has(w));
    if (keywords.length === 0) return pool.slice(0, n);
    const scored = pool.map((c) => {
      const hay = (c.anchor + " " + c.url).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (hay.includes(kw)) score += 2;
        // exact path segment match (e.g. /pricing) is a strong signal
        if (new URL(c.url, "http://x").pathname.split("/").some((seg) => seg === kw)) score += 3;
      }
      return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const matched = scored.filter((s) => s.score > 0).map((s) => s.c);
    return matched.length > 0 ? matched.slice(0, n) : pool.slice(0, n);
  };

  const llmPool = filtered.slice(0, 40);
  const list = llmPool
    .map((c, i) => `${i}) ${c.anchor || "(no text)"} → ${c.url}`)
    .join("\n");

  const system =
    "You are the link-selection module of an autonomous web intelligence agent. " +
    "Given the user's requirement, the current page being crawled, and a list of candidate links discovered on that page, " +
    "you must pick the subset of links most likely to contain information relevant to the requirement. " +
    "Judge by anchor text and URL path semantics against the SPECIFIC requirement — do not assume the user always wants the same kind of page. " +
    (isJobQuery
      ? "For this job/career requirement: always include any link whose anchor or URL mentions careers, jobs, hiring, openings, vacancies, recruit, or 'join us'. Prefer job-search/listing pages over signups or program info. "
      : "Pick links whose anchor/URL semantically matches the requirement's topic (e.g. pricing→/pricing, features→/features, api→/api or /docs, contact→/contact, about→/about, blog→/blog, docs→/docs). Do NOT default to careers/jobs links unless the requirement is about jobs. ") +
    "Avoid login/signup/cart/auth/social/legal/privacy links unless the requirement explicitly needs them.\n\n" +
    "STRICT RULES:\n" +
    "- Only return indices that exist in the candidate list below. Never invent or guess a URL.\n" +
    "- If no candidate clearly matches the requirement, pick the closest topical match or return an empty list.\n" +
    "- Do not include the same index twice. Return STRICT JSON only.";

  const user =
    `# User requirement\n${requirement.trim()}\n\n` +
    `# Current page\nURL: ${pageUrl}\nTitle: ${pageTitle}\n\n` +
    `# Candidate links (index · anchor → url)\n${list}\n\n` +
    `Pick at most ${maxPick} links most relevant to the requirement. ` +
    `Return JSON: {"indices":[...],"reason":"one short sentence"}. ` +
    `Indices are 0-based. Only include indices from the list above.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`link-select http ${res.status}`);
    }
    const data = await res.json();
    const content = data?.message?.content ?? "";
    const parsed = safeParse(content);
    if (!parsed || !Array.isArray(parsed.indices) || parsed.indices.length === 0) {
      // LLM returned nothing useful — use heuristic fallback.
      const picked = heuristicPick(filtered, maxPick);
      return {
        picked: picked.map((c) => c.url),
        reason: parsed ? "heuristic fallback (LLM returned no picks)" : "heuristic fallback (could not parse LLM)",
      };
    }
    const indices: number[] = parsed.indices.filter(
      (x) => Number.isInteger(x) && x >= 0 && x < llmPool.length,
    );
    const picked = indices.slice(0, maxPick).map((i) => llmPool[i].url);
    if (picked.length === 0) {
      const fb = heuristicPick(filtered, maxPick);
      return { picked: fb.map((c) => c.url), reason: "heuristic fallback (LLM picks out of range)" };
    }
    return {
      picked,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    // LLM failed/timed out — fall back to keyword matching so the crawl still progresses.
    const picked = heuristicPick(filtered, maxPick);
    return {
      picked: picked.map((c) => c.url),
      reason: `heuristic fallback (${err instanceof Error ? err.message : "link-select failed"})`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function safeParse(content: string): { indices?: unknown; reason?: unknown } | null {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}