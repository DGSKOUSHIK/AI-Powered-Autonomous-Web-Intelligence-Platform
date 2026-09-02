import { NextRequest } from "next/server";
import {
  DEFAULT_CRAWL_CONFIG,
  crawlTree,
  buildTreeNodes,
  buildCombinedContent,
  type PageNode,
  type JobPosting,
} from "./crawler";
import { appendMessage, appendUserMessage, getCurrentUser, type JobDoc, type MessageDoc } from "../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e2b";

interface AnalyzeBody {
  url: string;
  requirement: string;
  sessionId?: string;
}

type StatusEvent = { type: "status"; stage: string; detail?: string };
type PageEvent = {
  type: "page";
  url: string;
  title: string;
  depth: number;
  status: string;
  chars: number;
};
type TreeEvent = { type: "tree"; root: string; nodes: Record<string, unknown> };
type PickEvent = {
  type: "pick";
  parent: string;
  picked: string[];
  reason: string;
  totalCandidates: number;
};
type JobEvent = {
  type: "job";
  source: string;
  job: {
    title: string;
    url?: string;
    company?: string;
    location?: string;
    locationString?: string;
    description?: string;
    datePosted?: string;
    employmentType?: string;
    workHours?: string;
    jobId?: string;
    salary?: string;
    source: string;
  };
};
type TokenEvent = { type: "token"; delta: string };
type DoneEvent = {
  type: "done";
  title: string;
  url: string;
  pages: number;
  contentLength: number;
  jobs: number;
};
type ErrorEvent = { type: "error"; message: string };
type StreamEvent =
  | StatusEvent
  | PageEvent
  | TreeEvent
  | PickEvent
  | JobEvent
  | TokenEvent
  | DoneEvent
  | ErrorEvent;

function encode(obj: StreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

function buildPrompt(
  rootTitle: string,
  rootUrl: string,
  combined: string,
  requirement: string,
  jobCount: number,
): { system: string; user: string } {
  const isJobQuery = /\b(job|jobs|hiring|career|careers|opening|openings|position|vacanc|recruit|join us|work with us)\b/i.test(
    requirement,
  );

  const system =
    "You are WebIntel, an autonomous web intelligence agent. You are given the scraped text content of MULTIPLE web pages from a single website, organized as a tree crawl (the seed page plus linked pages up to a few hops deep). " +
    "Analyze all the provided content together against the user's requirement and write a clear, well-structured answer that is easy to read on a screen.\n\n" +
    "The user's requirement is the single source of truth for what the answer should be about. Answer THAT question specifically — do not default to summarizing jobs, careers, or postings unless the requirement is about jobs. " +
    "Tailor the structure and focus of your answer to the topic the user asked about (pricing, features, API, tech stack, contact info, product summary, company info, etc.).\n\n" +
    (isJobQuery && jobCount > 0
      ? `The crawl detected ${jobCount} structured job postings, listed at the end under "Job postings detected during crawl". Summarize them: group by role or location if there are many, mention the count, locations, and recency. Do not repeat every posting verbatim.\n\n`
      : "") +
    "GROUNDING & ANTI-HALLUCINATION RULES (most important — never violate):\n" +
    "- You may ONLY state facts that are directly supported by the text in the crawled pages above. Treat the provided page contents as your entire universe of knowledge for this answer.\n" +
    "- Do NOT use outside knowledge, training data, assumptions, or guesses to fill gaps. If a fact is not written in the provided content, you do not know it.\n" +
    "- Do NOT invent prices, features, API endpoints, names, dates, numbers, or quotes that do not appear in the source text. Numbers and specific values are especially dangerous — only reproduce values you can see in the content.\n" +
    "- When you state a non-obvious fact, cite the source page with a Markdown link from the URLs provided in the content (e.g. [Pricing](url)). If you cannot find a supporting URL, phrase it as 'according to the site' without inventing a link.\n" +
    "- If the crawled content is INSUFFICIENT or SILENT on the user's question, you MUST say so plainly: 'The crawled pages do not mention X.' Then explain exactly what information is missing and, if possible, which page or section would likely contain it. Do not answer a different question than the one asked.\n" +
    "- Never present an inference as a fact. If you are inferring or combining information, mark it explicitly: 'This suggests…' or 'Based on the pages, it appears…'.\n" +
    "- Distinguish clearly between what the site states and what it implies. Quote or paraphrase the site's own wording for critical claims.\n" +
    "- If two pages conflict, surface the conflict rather than silently picking one.\n\n" +
    "FORMATTING RULES (important for readability):\n" +
    "- Start with one short sentence directly answering the question (or stating that the content is insufficient).\n" +
    "- Use ## headings to group related information into sections.\n" +
    "- Use bullet points for lists; keep each bullet under ~2 lines.\n" +
    "- Bold key terms or names the first time you mention them.\n" +
    "- Use inline `code` for identifiers, paths, field names, or short technical values.\n" +
    "- If comparing options, use a Markdown table.\n" +
    "- Keep paragraphs short (2–3 sentences). Avoid long walls of text.\n" +
    "- Prefer readable link text like [Pricing page](url) over raw URLs.\n\n" +
    "CONTENT RULES:\n" +
    "- Be concise but complete. Answer the specific question asked, nothing more.\n" +
    "- Write in plain, friendly English. No marketing tone, no filler, no hedging beyond what accuracy requires.\n" +
    "- Prefer specificity over generality. 'The Starter plan costs $19/month' is better than 'They have a cheap plan'.";
  void isJobQuery;

  const user =
    `# Task\n${requirement.trim()}\n\n` +
    `# Source Website\nSeed URL: ${rootUrl}\nRoot title: ${rootTitle}\n\n` +
    `# Crawled Page Contents (multiple pages — this is your ONLY source of truth)\n"""\n${combined}\n"""\n\n` +
    `Write the answer for the user, focused on their specific requirement above. ` +
    `Use ONLY facts present in the content above. If the content does not cover the requirement, say so explicitly. ` +
    `Follow the formatting and grounding rules exactly.`;

  return { system, user };
}

export async function POST(req: NextRequest) {
  const authUser = await getCurrentUser();
  if (!authUser) {
    return new Response(
      new TextEncoder().encode(JSON.stringify({ error: "Unauthorized" }) + "\n"),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  let body: AnalyzeBody;
  try {
    body = (await req.json()) as AnalyzeBody;
  } catch {
    return new Response(
      new TextEncoder().encode(JSON.stringify({ error: "Invalid JSON" }) + "\n"),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const { url: rawUrl, requirement, sessionId: reqSessionId } = body;
  if (!rawUrl || typeof rawUrl !== "string") {
    return Response.json({ error: "url is required" }, { status: 400 });
  }
  if (!requirement || typeof requirement !== "string") {
    return Response.json(
      { error: "requirement is required" },
      { status: 400 },
    );
  }

  // Length caps — prevent prompt-injection / DoS via huge inputs.
  const MAX_URL_LEN = 2048;
  const MAX_REQ_LEN = 4000;
  if (rawUrl.length > MAX_URL_LEN) {
    return Response.json({ error: `url too long (max ${MAX_URL_LEN} chars)` }, { status: 400 });
  }
  if (requirement.length > MAX_REQ_LEN) {
    return Response.json({ error: `requirement too long (max ${MAX_REQ_LEN} chars)` }, { status: 400 });
  }

  // Basic URL format validation (scheme + host).
  let parsedUrl: URL;
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl.trim())
      ? rawUrl.trim()
      : `https://${rawUrl.trim()}`;
    parsedUrl = new URL(withScheme);
  } catch {
    return Response.json({ error: "url is not valid" }, { status: 400 });
  }
  if (!parsedUrl.hostname || !/\.[a-z]{2,}$/i.test(parsedUrl.hostname)) {
    return Response.json({ error: "url must have a valid hostname" }, { status: 400 });
  }
  const safeUrl = parsedUrl.toString();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StreamEvent) => controller.enqueue(encode(e));

      // accumulate for persistence
      const acc = {
        crawled: [] as { url: string; title: string; depth: number; status: string }[],
        picks: [] as { parent: string; picked: string[]; reason: string }[],
        jobs: [] as JobDoc[],
        answer: "",
        title: "",
        pages: 0,
        contentLength: 0,
        startedAt: Date.now(),
      };

      const persist = async (extra?: Partial<MessageDoc>) => {
        if (!reqSessionId) return;
        const msg: MessageDoc = {
          id: crypto.randomUUID(),
          role: "agent",
          url: safeUrl,
          requirement,
          answer: acc.answer,
          jobs: acc.jobs,
          crawl: {
            pages: acc.pages,
            contentLength: acc.contentLength,
            crawledUrls: acc.crawled,
            picks: acc.picks,
          },
          title: acc.title,
          pages: acc.pages,
          durationMs: Date.now() - acc.startedAt,
          createdAt: new Date(),
          ...extra,
        };
        try {
          await appendMessage(reqSessionId, msg, acc.title || requirement.slice(0, 60));
        } catch {
          // ignore persistence errors
        }
      };

      try {
        send({ type: "status", stage: "crawl", detail: "starting tree crawl" });

        if (reqSessionId) {
          try {
            await appendUserMessage(
              reqSessionId,
              { id: crypto.randomUUID(), url: safeUrl, requirement, createdAt: new Date() },
              requirement.slice(0, 60),
            );
          } catch {
            // ignore persistence errors
          }
        }

        const onPage = (node: PageNode) => {
          acc.crawled.push({
            url: node.url,
            title: node.title,
            depth: node.depth,
            status: node.status,
          });
          send({
            type: "page",
            url: node.url,
            title: node.title,
            depth: node.depth,
            status: node.status,
            chars: node.chars,
          });
        };

        const onPick = (
          parentUrl: string,
          picked: string[],
          reason: string,
          _totalCandidates: number,
        ) => {
          acc.picks.push({ parent: parentUrl, picked, reason });
          send({
            type: "pick",
            parent: parentUrl,
            picked,
            reason,
            totalCandidates: _totalCandidates,
          });
        };

        const onJobs = (sourceUrl: string, jobs: JobPosting[]) => {
          for (const job of jobs) {
            const doc: JobDoc = {
              title: job.title,
              url: job.url,
              company: job.company,
              location: job.location || job.locationString,
              datePosted: job.datePosted,
              employmentType: job.employmentType,
              jobId: job.jobId,
              salary: job.salary,
              source: sourceUrl,
            };
            acc.jobs.push(doc);
            send({ type: "job", source: sourceUrl, job: doc as unknown as JobEvent["job"] });
          }
        };

        const result = await crawlTree(
          safeUrl,
          requirement,
          DEFAULT_CRAWL_CONFIG,
          onPage,
          onPick,
          onJobs,
        );

        send({ type: "tree", root: result.rootUrl, nodes: buildTreeNodes(result).nodes });

        if (result.pages.length === 0) {
          const errMsg =
            "Could not extract meaningful text from any crawled page. The site may be JavaScript-rendered, a PDF, or behind bot protection.";
          send({ type: "error", message: errMsg });
          await persist({ error: errMsg });
          controller.close();
          return;
        }

        const isJobQuery = /\b(job|jobs|hiring|career|careers|opening|openings|position|vacanc|recruit|join us|work with us)\b/i.test(
          requirement,
        );

        const combined = buildCombinedContent(result, isJobQuery);
        const rootPage = result.pages.find((p) => p.depth === 0);
        const rootTitle = rootPage?.title || new URL(result.rootUrl).hostname;

        send({
          type: "status",
          stage: "analyze",
          detail: `${result.pages.length} pages · ${result.totalChars.toLocaleString()} chars`,
        });

        const { system, user } = buildPrompt(
          rootTitle,
          result.rootUrl,
          combined,
          requirement,
          isJobQuery ? result.jobs.length : 0,
        );

        const ollamaController = new AbortController();
        const ollamaTimeout = setTimeout(() => ollamaController.abort(), 300000);
        let ollamaRes: Response;
        try {
          ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: OLLAMA_MODEL,
              stream: true,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              options: { temperature: 0.4 },
            }),
            signal: ollamaController.signal,
          });
        } catch (err) {
          clearTimeout(ollamaTimeout);
          const msg =
            (err as Error).name === "AbortError"
              ? `Ollama timed out after 5 minutes. Is "${OLLAMA_MODEL}" loaded? The model may be too slow for this much content.`
              : `Could not reach Ollama at ${OLLAMA_HOST}. Make sure it is running.`;
          send({ type: "error", message: msg });
          await persist({ error: msg });
          controller.close();
          return;
        }
        clearTimeout(ollamaTimeout);

        if (!ollamaRes.ok || !ollamaRes.body) {
          const errText = await ollamaRes.text().catch(() => "");
          send({
            type: "error",
            message: `Ollama error ${ollamaRes.status}: ${errText || ollamaRes.statusText}. Make sure "${OLLAMA_MODEL}" is available.`,
          });
          controller.close();
          return;
        }

        const reader = ollamaRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let first = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                if (first) {
                  send({ type: "status", stage: "stream" });
                  first = false;
                }
                acc.answer += json.message.content;
                send({ type: "token", delta: json.message.content });
              }
              if (json.error) {
                send({ type: "error", message: String(json.error) });
                await persist({ error: String(json.error) });
                controller.close();
                return;
              }
            } catch {
              // partial JSON
            }
          }
        }

        acc.title = rootTitle;
        acc.pages = result.pages.length;
        acc.contentLength = result.totalChars;
        send({
          type: "done",
          title: rootTitle,
          url: result.rootUrl,
          pages: result.pages.length,
          contentLength: result.totalChars,
          jobs: result.jobs.length,
        });
        await persist();
        controller.close();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown error during analysis";
        send({ type: "error", message });
        await persist({ error: message });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}