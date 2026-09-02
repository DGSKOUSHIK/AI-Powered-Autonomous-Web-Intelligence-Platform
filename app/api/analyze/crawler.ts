import * as cheerio from "cheerio";
import { selectLinks, type LinkCandidate } from "./link-selector";
import { renderPage } from "./renderer";
import {
  extractStructuredData,
  detectJobsFromText,
  detectJobsFromDom,
  mergeJobs,
  type JobPosting,
} from "./jobs";

export type { JobPosting };

export interface PageNode {
  url: string;
  title: string;
  depth: number;
  status: "ok" | "skip" | "error" | "rendered";
  chars: number;
  children: string[];
  pickReason?: string;
  rendered?: boolean;
  jobs?: number;
}

export interface CrawlResult {
  nodes: Map<string, PageNode>;
  rootUrl: string;
  pages: { url: string; title: string; text: string; depth: number }[];
  totalChars: number;
  jobs: JobPosting[];
  jobSourceUrls: string[];
}

export interface CrawlConfig {
  maxDepth: number;
  maxPages: number;
  concurrency: number;
  perPageTimeoutMs: number;
  maxCharsPerPage: number;
  maxTotalChars: number;
  maxLinksPerNode: number;
  renderFallback: boolean;
  minTextChars: number;
}

export const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  maxDepth: 3,
  maxPages: 20,
  concurrency: 5,
  perPageTimeoutMs: 20000,
  maxCharsPerPage: 8000,
  maxTotalChars: 24000,
  maxLinksPerNode: 4,
  renderFallback: true,
  minTextChars: 20,
};

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return "https://" + trimmed;
  return trimmed;
}

function cleanUrl(u: string): string | null {
  try {
    const parsed = new URL(u);
    // drop fragments, strip trailing slash for dedup (but keep root "/")
    parsed.hash = "";
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
    parsed.pathname = path;
    return parsed.toString();
  } catch {
    return null;
  }
}

function registrableDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  // simple heuristic: last two labels (ignores multi-part TLDs like co.uk)
  return parts.slice(-2).join(".");
}

function sameSite(linkHost: string, seedDomain: string): boolean {
  return linkHost === seedDomain || linkHost.endsWith("." + seedDomain);
}

async function fetchPage(
  url: string,
  timeoutMs: number,
): Promise<{ html: string; ok: boolean; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; WebIntelBot/1.0; +https://webintel.local/bot)",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    const ct = res.headers.get("content-type") || "";
    if (!/text|html|xml|json/i.test(ct)) {
      return { html: "", ok: false, status: res.status };
    }
    const html = await res.text();
    return { html, ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractContent(
  html: string,
  maxChars: number,
  pageUrl: string,
): {
  title: string;
  text: string;
  rawText: string;
  bodyHtml: string;
  links: string[];
  candidates: LinkCandidate[];
} {
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, svg, iframe, canvas, template, link, meta, head",
  ).remove();

  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "";

  let baseUrl = pageUrl;
  const baseHref = $("base").first().attr("href");
  if (baseHref) {
    try {
      baseUrl = new URL(baseHref, pageUrl).toString();
    } catch {
      // keep pageUrl
    }
  }

  // collect same-origin-ish links with anchor text
  const seen = new Set<string>();
  const candidates: LinkCandidate[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:") ||
      href.startsWith("#")
    )
      return;
    try {
      const abs = new URL(href, baseUrl).toString();
      if (seen.has(abs)) return;
      seen.add(abs);
      const anchor = $(el).text().trim().replace(/\s+/g, " ").slice(0, 80);
      candidates.push({ url: abs, anchor });
    } catch {
      // ignore invalid
    }
  });
  const links = candidates.map((c) => c.url);

  const root = $(
    "main, article, [role='main'], #content, .content, .post, .article, body",
  ).first();
  const target = root.length ? root : $("body");
  target.find("p, br, h1, h2, h3, h4, li, div").after("\n");
  const rawText = target
    .text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  let text = rawText;
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n…[truncated]";
  const bodyHtml = target.html() || "";
  return { title, text, rawText, bodyHtml, links, candidates };
}

export async function crawlTree(
  seedRaw: string,
  requirement: string,
  config: CrawlConfig,
  onPage: (node: PageNode) => void,
  onPick: (parentUrl: string, picked: string[], reason: string, totalCandidates: number) => void,
  onJobs: (sourceUrl: string, jobs: JobPosting[]) => void,
): Promise<CrawlResult> {
  const seed = normalizeUrl(seedRaw);
  const parsed = new URL(seed);
  const seedDomain = registrableDomain(parsed.hostname);

  const nodes = new Map<string, PageNode>();
  const visited = new Set<string>();
  const pages: CrawlResult["pages"] = [];
  const allJobs: JobPosting[] = [];
  const jobSourceUrls = new Set<string>();
  let totalChars = 0;

  const isJobQuery = /job|hire|hiring|career|opening|position|vacanc|recruit/i.test(
    requirement,
  );

  // BFS queue
  type QueueItem = { url: string; depth: number; parent: string | null };
  const queue: QueueItem[] = [{ url: seed, depth: 0, parent: null }];
  visited.add(cleanUrl(seed) ?? seed);

  const collectJobs = (url: string, html: string, rawText: string, bodyHtml: string) => {
    if (!isJobQuery) return 0; // skip job extraction entirely for non-job queries
    const structured = extractStructuredData(html, url);
    const domJobs = detectJobsFromDom(bodyHtml || html, url);
    const textJobs = detectJobsFromText(rawText, url);
    const merged = mergeJobs(structured.jobs, domJobs, textJobs);
    if (merged.length > 0) {
      jobSourceUrls.add(url);
      allJobs.push(...merged);
      onJobs(url, merged);
    }
    return merged.length;
  };

  const visit = async (item: QueueItem): Promise<void> => {
    const node: PageNode = {
      url: item.url,
      title: "",
      depth: item.depth,
      status: "skip",
      chars: 0,
      children: [],
    };

    if (totalChars >= config.maxTotalChars) {
      // Text budget exhausted — but for job queries, still fetch+render to
      // extract structured job postings (jobs don't count against text budget).
      if (isJobQuery) {
        try {
          const fetched = await fetchPage(item.url, config.perPageTimeoutMs);
          let pageHtml = fetched.html;
          let pageRawText = "";
          if (pageHtml) {
            const ext = extractContent(pageHtml, config.maxCharsPerPage, item.url);
            pageRawText = ext.rawText;
            // quick static job check
            let sj = 0;
            try {
              const st = extractStructuredData(pageHtml, item.url);
              const dj = detectJobsFromDom(ext.bodyHtml || pageHtml, item.url);
              const tj = detectJobsFromText(ext.rawText, item.url);
              sj = mergeJobs(st.jobs, dj, tj).length;
            } catch {
              // ignore
            }
            const host = (() => {
              try {
                return new URL(item.url).hostname;
              } catch {
                return "";
              }
            })();
            const spa = /career|apply|jobs|recruit|eightfold|greenhouse|lever/i.test(
              host + item.url,
            );
            if (config.renderFallback && (ext.rawText.length < config.minTextChars || (spa && sj === 0))) {
              try {
                const rendered = await renderPage(item.url, config.perPageTimeoutMs, 9000);
                if (rendered.html && rendered.text.length > 200) {
                  pageHtml = rendered.html;
                  pageRawText = rendered.text.slice(0, config.maxTotalChars);
                }
              } catch {
                // ignore
              }
            }
            node.title = ext.title || new URL(item.url).hostname;
            const n = collectJobs(item.url, pageHtml, pageRawText, ext.bodyHtml);
            node.jobs = n;
          }
        } catch {
          // ignore
        }
      }
      nodes.set(item.url, node);
      onPage(node);
      return;
    }

    let html = "";
    let status = 0;
    let usedRender = false;

    try {
      // 1) static fetch
      const fetched = await fetchPage(item.url, config.perPageTimeoutMs);
      html = fetched.html;
      status = fetched.status;

      let extracted = extractContent(html, config.maxCharsPerPage, item.url);

      // quick static job scan to decide if we need JS rendering
      let staticJobs = 0;
      try {
        const structured = extractStructuredData(html, item.url);
        const domJobs = detectJobsFromDom(extracted.bodyHtml || html, item.url);
        const textJobs = detectJobsFromText(extracted.rawText, item.url);
        staticJobs = mergeJobs(structured.jobs, domJobs, textJobs).length;
      } catch {
        // ignore
      }

      const host = (() => {
        try {
          return new URL(item.url).hostname;
        } catch {
          return "";
        }
      })();
      const looksSpa =
        /career|jobs|apply|eightfold|greenhouse|lever|workday|taleo|smartrecruit|ashby|bamboohr/i.test(
          host + item.url,
        );

      const needsRender =
        config.renderFallback &&
        (fetched.ok || extracted.rawText.length < config.minTextChars || looksSpa) &&
        (!fetched.ok ||
          extracted.rawText.length < config.minTextChars ||
          (isJobQuery && staticJobs === 0 && looksSpa) ||
          (isJobQuery && extracted.candidates.length === 0));

      // 2) render fallback if static content is thin / SPA / job page with no jobs/links
      if (needsRender) {
        try {
          const rendered = await renderPage(
            item.url,
            config.perPageTimeoutMs,
            9000,
          );
          // Use render if it yields more text OR more links (JS-injected nav)
          const renderedExtract = extractContent(
            rendered.html,
            config.maxCharsPerPage,
            item.url,
          );
          const betterText = rendered.text.length > extracted.rawText.length;
          const betterLinks =
            renderedExtract.candidates.length > extracted.candidates.length;
          if (betterText || (isJobQuery && betterLinks)) {
            html = rendered.html;
            usedRender = true;
            extracted = renderedExtract;
            if (rendered.text.length > extracted.rawText.length) {
              extracted.rawText = rendered.text.slice(0, config.maxTotalChars);
              extracted.text =
                rendered.text.length > config.maxCharsPerPage
                  ? rendered.text.slice(0, config.maxCharsPerPage) + "\n…[truncated]"
                  : rendered.text;
            }
          }
        } catch {
          // render failed; keep static results
        }
      }

      void staticJobs;

      if (!html) {
        node.status = "error";
        node.title = `HTTP ${status}`;
        nodes.set(item.url, node);
        onPage(node);
        return;
      }

      node.title = extracted.title || new URL(item.url).hostname;
      node.status = extracted.text.length > config.minTextChars ? "ok" : "skip";
      node.chars = extracted.text.length;
      if (usedRender) node.rendered = true;
      nodes.set(item.url, node);

      if (node.status === "ok") {
        pages.push({
          url: item.url,
          title: node.title,
          text: extracted.text,
          depth: item.depth,
        });
        totalChars += extracted.text.length;
      }

      // 3) job extraction (always attempt; more aggressive for job queries)
      try {
        const n = collectJobs(item.url, html, extracted.rawText, extracted.bodyHtml);
        node.jobs = n;
      } catch {
        // ignore job extraction errors
      }

      // 4) LLM-driven link selection (requirement-aware)
      if (item.depth < config.maxDepth && nodes.size < config.maxPages) {
        // For job queries, proactively discover career/jobs sections:
        //  (a) any candidate link whose anchor/URL screams "careers/jobs"
        //  (b) common job-board subdomains/paths derived from the seed domain
        // These bypass the LLM selector — they are force-included as high-value.
        const forcedJobUrls: string[] = [];
        if (isJobQuery) {
          // (a) auto-pick obvious careers/jobs links present on the page
          for (const cand of extracted.candidates) {
            const sig = (cand.anchor + " " + cand.url).toLowerCase();
            if (
              /\b(careers?|jobs?|job-search|job-listings|openings|vacanc|recruit|hiring|join us|work with us|career site)\b/.test(
                sig,
              )
            ) {
              const c = cleanUrl(cand.url);
              if (c && !visited.has(c)) forcedJobUrls.push(c);
            }
          }

          // (b) probe a FEW high-value job-board endpoints derived from the domain.
          //     Keep this small — over-probing floods the crawl queue.
          const probed: string[] = [];
          try {
            const u = new URL(item.url);
            const proto = u.protocol;
            const domain = registrableDomain(u.hostname);
            const curHost = u.hostname;
            // Target set: careers subdomain + its apply.* sibling (Eightfold pattern),
            // plus the bare apply/jobs subdomains. Only the /careers path (the listing
            // page) — not every variant.
            const targets = new Set<string>([
              `${proto}//careers.${domain}/careers`,
              `${proto}//apply.careers.${domain}/careers`,
              `${proto}//apply.${domain}/careers`,
              `${proto}//jobs.${domain}/careers`,
            ]);
            if (curHost.startsWith("careers.")) {
              targets.add(`${proto}//apply.${curHost}/careers`);
            }
            for (const t of targets) probed.push(t);
          } catch {
            // ignore
          }
          for (const p of probed) {
            const c = cleanUrl(p);
            if (!c || visited.has(c) || forcedJobUrls.includes(c)) continue;
            forcedJobUrls.push(c);
          }
        }

        const sameSiteCandidates = extracted.candidates.filter((c) => {
          try {
            return sameSite(new URL(c.url).hostname, seedDomain);
          } catch {
            return false;
          }
        });

        let pickedUrls: string[] = [];
        let reason = "";
        if (sameSiteCandidates.length > 0) {
          const budget = Math.min(
            config.maxLinksPerNode,
            config.maxPages - nodes.size,
          );
          const selection = await selectLinks(
            requirement,
            item.url,
            node.title,
            sameSiteCandidates,
            Math.max(1, budget),
          );
          pickedUrls = selection.picked;
          reason = selection.reason;
        }
        node.pickReason = reason;
        onPick(item.url, pickedUrls, reason, sameSiteCandidates.length);

        for (const rawLink of pickedUrls) {
          const clean = cleanUrl(rawLink);
          if (!clean) continue;
          if (visited.has(clean)) continue;
          if (nodes.size + queue.length >= config.maxPages) break;
          visited.add(clean);
          node.children.push(clean);
          queue.push({ url: clean, depth: item.depth + 1, parent: item.url });
        }

        // force-include auto-picked + probed job endpoints (bypass LLM)
        for (const clean of forcedJobUrls) {
          if (nodes.size + queue.length >= config.maxPages) break;
          if (visited.has(clean)) continue;
          visited.add(clean);
          node.children.push(clean);
          queue.push({ url: clean, depth: item.depth + 1, parent: item.url });
        }
      }
      onPage(node);
    } catch (err) {
      node.status = "error";
      node.title =
        err instanceof Error && err.name === "AbortError"
          ? "timeout"
          : (err instanceof Error ? err.message : "error");
      nodes.set(item.url, node);
      onPage(node);
    }
  };

  // simple concurrent pool over the queue
  while (queue.length > 0 && nodes.size < config.maxPages) {
    const batch: QueueItem[] = [];
    while (queue.length > 0 && batch.length < config.concurrency) {
      const next = queue.shift()!;
      if (nodes.size + batch.length >= config.maxPages) {
        queue.unshift(next);
        break;
      }
      batch.push(next);
    }
    await Promise.all(batch.map(visit));
  }

  void isJobQuery;
  return {
    nodes,
    rootUrl: seed,
    pages,
    totalChars,
    jobs: allJobs,
    jobSourceUrls: [...jobSourceUrls],
  };
}

export function buildTreeNodes(result: CrawlResult) {
  const out: Record<
    string,
    {
      title: string;
      depth: number;
      status: string;
      chars: number;
      children: string[];
      pickReason?: string;
      rendered?: boolean;
      jobs?: number;
    }
  > = {};
  for (const [url, node] of result.nodes) {
    out[url] = {
      title: node.title,
      depth: node.depth,
      status: node.status,
      chars: node.chars,
      children: node.children,
      pickReason: node.pickReason,
      rendered: node.rendered,
      jobs: node.jobs,
    };
  }
  return { root: result.rootUrl, nodes: out };
}

export function buildCombinedContent(
  result: CrawlResult,
  isJobQuery = false,
): string {
  // sort pages by depth then url for stable ordering
  const sorted = [...result.pages].sort(
    (a, b) => a.depth - b.depth || a.url.localeCompare(b.url),
  );
  const parts: string[] = [];
  for (const p of sorted) {
    parts.push(
      `## Page: ${p.title || "(untitled)"}\nURL: ${p.url}\nDepth: ${p.depth}\n\n${p.text}`,
    );
  }

  // Only include detected job postings in the context when the user
  // actually asked about jobs. Otherwise they bias the answer.
  if (isJobQuery && result.jobs.length > 0) {
    const jobsMd = result.jobs
      .slice(0, 60)
      .map(
        (j) =>
          `- **${j.title}**${j.company ? ` — ${j.company}` : ""}${
            j.location || j.locationString ? ` (${j.location || j.locationString})` : ""
          }${j.datePosted ? ` · ${j.datePosted}` : ""}${
            j.url ? ` · ${j.url}` : ""
          }${j.employmentType ? ` · ${j.employmentType}` : ""}`,
      )
      .join("\n");
    parts.push(`## Job postings detected during crawl (${result.jobs.length})\n${jobsMd}`);
  }

  let combined = parts.join("\n\n---\n\n");
  if (combined.length > DEFAULT_CRAWL_CONFIG.maxTotalChars) {
    combined = combined.slice(0, DEFAULT_CRAWL_CONFIG.maxTotalChars) + "\n…[truncated]";
  }
  return combined;
}