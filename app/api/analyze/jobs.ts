import * as cheerio from "cheerio";

export interface JobPosting {
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
  source: "jsonld" | "microdata" | "text" | "dom";
}

export interface StructuredData {
  jobs: JobPosting[];
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  schemaTypes: string[];
}

export function extractStructuredData(html: string, pageUrl: string): StructuredData {
  const $ = cheerio.load(html);
  const jobs: JobPosting[] = [];
  const schemaTypes: string[] = [];

  // 1. JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      collectJsonLd(item, pageUrl, jobs, schemaTypes);
    }
  });

  // 2. Microdata (itemtype = .../JobPosting)
  $('[itemtype*="JobPosting"]').each((_, el) => {
    const $el = $(el);
    const job: JobPosting = { title: "", source: "microdata" };
    $el.find("[itemprop]").each((__, p) => {
      const prop = $(p).attr("itemprop") || "";
      const val = ($(p).attr("content") || $(p).text() || "").trim();
      assignJobField(job, prop, val);
    });
    if (job.title) jobs.push(job);
  });

  // Open Graph
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription = $('meta[property="og:description"]').attr("content");
  const ogType = $('meta[property="og:type"]').attr("content");

  return {
    jobs,
    ogTitle,
    ogDescription,
    ogType,
    schemaTypes: [...new Set(schemaTypes)],
  };
}

function collectJsonLd(
  node: unknown,
  pageUrl: string,
  jobs: JobPosting[],
  schemaTypes: string[],
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (n["@type"]) {
    const type = Array.isArray(n["@type"]) ? n["@type"].join(",") : String(n["@type"]);
    schemaTypes.push(type);
  }
  // JobPosting
  const type = n["@type"];
  const typeStr = Array.isArray(type) ? type.join("|") : String(type ?? "");
  if (typeStr.includes("JobPosting")) {
    const job: JobPosting = { title: "", source: "jsonld" };
    if (typeof n.title === "string") job.title = n.title;
    if (typeof n.url === "string") job.url = abs(n.url, pageUrl);
    if (typeof n.description === "string") job.description = n.description.slice(0, 2000);
    if (typeof n.datePosted === "string") job.datePosted = n.datePosted;
    if (typeof n.employmentType === "string") job.employmentType = n.employmentType;
    if (typeof n.jobId === "string") job.jobId = n.jobId;
    const hiringOrg = n.hiringOrganization as Record<string, unknown> | undefined;
    if (hiringOrg && typeof hiringOrg.name === "string") job.company = hiringOrg.name;
    const loc = n.jobLocation as Record<string, unknown> | undefined;
    if (loc) {
      const addr = loc.address as Record<string, unknown> | undefined;
      if (addr) {
        const parts = [
          addr.addressLocality,
          addr.addressRegion,
          addr.addressCountry,
        ].filter((x): x is string => typeof x === "string" && x.length > 0);
        if (parts.length) job.locationString = parts.join(", ");
      }
    }
    const remote = n.jobLocationType;
    if (typeof remote === "string") job.workHours = remote;
    const base = n.baseSalary as Record<string, unknown> | undefined;
    if (base) {
      const val = base.currency as Record<string, unknown> | undefined;
      if (val && typeof val.value === "number") job.salary = String(val.value);
    }
    if (job.title) jobs.push(job);
  }
  // recurse into @graph or children
  if (Array.isArray(n["@graph"])) {
    for (const g of n["@graph"]) collectJsonLd(g, pageUrl, jobs, schemaTypes);
  }
  if (Array.isArray(n.itemListElement)) {
    for (const g of n.itemListElement) collectJsonLd(g, pageUrl, jobs, schemaTypes);
  }
}

function assignJobField(job: JobPosting, prop: string, val: string): void {
  switch (prop) {
    case "title":
      job.title = val;
      break;
    case "url":
      job.url = val;
      break;
    case "description":
      job.description = val;
      break;
    case "datePosted":
      job.datePosted = val;
      break;
    case "employmentType":
      job.employmentType = val;
      break;
    case "jobId":
      job.jobId = val;
      break;
    case "hiringOrganization":
      job.company = val;
      break;
    case "jobLocation":
      job.location = val;
      break;
  }
}

function abs(u: string, base: string): string {
  try {
    return new URL(u, base).toString();
  } catch {
    return u;
  }
}

/* ---------- Text / DOM job-card heuristic ---------- */

const JOB_KEYWORDS = [
  "engineer",
  "developer",
  "manager",
  "designer",
  "analyst",
  "consultant",
  "architect",
  "specialist",
  "director",
  "lead",
  "scientist",
  "technician",
  "coordinator",
  "administrator",
  "intern",
  "recruiter",
  "representative",
  "officer",
  "associate",
  "head",
  "president",
  "vp",
  "vice president",
  "program manager",
  "product manager",
  "software engineer",
  "data scientist",
  "solutions architect",
  "business program",
  "cloud solution",
  "data engineer",
  "security engineer",
  "site reliability",
  "customer",
  "sales",
  "marketing",
  "operations",
  "finance",
  "human resources",
];

const LOCATION_HINT =
  /\b([A-Z][a-zA-Z.\s]+,\s*(?:[A-Z][a-zA-Z.\s]+(?:,\s*[A-Z][a-zA-Z.\s]+)?|Multiple Locations))\b/;
const POSTED_HINT =
  /(posted\s+)?(an?\s+hour|hours?|days?|weeks?|months?|just now)\s*ago/i;

export function detectJobsFromText(
  text: string,
  pageUrl: string,
): JobPosting[] {
  void pageUrl;
  const jobs: JobPosting[] = [];
  if (!text) return jobs;

  // Split into lines / chunks and look for title + location + posted clusters
  const lines = text
    .split(/\n|\s{3,}|•|\|/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length < 200);

  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 8 || line.length > 160) continue;
    if (line.split(/\s+/).length > 18) continue;
    // skip lines that are mostly a URL or navigation noise
    if (/^https?:\/\//.test(line)) continue;
    if (/(https?:\/\/|www\.)/.test(line) && line.replace(/\S+/g, "").length > line.length * 0.5) continue;
    if (/^(home|search|sign in|sign up|login|menu|skip to|filter|sort by|apply|clear|all filters)\b/i.test(line)) continue;
    // skip sentence-like lines (job descriptions, responsibilities, requirements)
    const wordCount = line.split(/\s+/).length;
    const sentenceWords = line.toLowerCase().match(/\b(to|by|with|and|or|of|the|a|an|in|for|that|which|while|during|across|through|including|such as|via|using|experience|years|familiarity)\b/g);
    const sentenceScore = sentenceWords ? sentenceWords.length : 0;
    if (wordCount > 6 && sentenceScore / wordCount > 0.25) continue;
    if (/\b(to|by|including|sharing|collaborating|accelerate|resolve|lead|drive|build|deliver|manage)\s/i.test(line) && wordCount > 6) continue;
    // skip lines starting with a number + period (list items like "3. Specialist")
    if (/^\d+\.\s/.test(line)) continue;

    const hasKeyword = JOB_KEYWORDS.some((k) => {
      const re = new RegExp("\\b" + k.replace(/[.+]/g, "\\$&") + "\\b", "i");
      return re.test(line);
    });
    if (!hasKeyword) continue;

    // look ahead up to 4 lines for location + posted
    let location = "";
    let posted = "";
    let company = "";
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const cand = lines[j];
      if (!location) {
        const m = cand.match(LOCATION_HINT);
        if (m) location = m[0];
      }
      if (!posted && POSTED_HINT.test(cand)) {
        posted = cand.replace(/\s+/g, " ").trim();
      }
      if (!company && /\b(inc|llc|ltd|corp|corporation|company|technologies|labs)\b/i.test(cand) && cand.length < 60) {
        company = cand;
      }
      if (location && posted) break;
    }

    // Require at least one corroborating signal: location OR posted-time.
    // This filters out bare category labels like "Developer & IT", "Marketing".
    if (!location && !posted) continue;

    const key = line.toLowerCase() + "|" + location;
    if (seen.has(key)) continue;
    seen.add(key);

    jobs.push({
      title: line,
      location: location || undefined,
      datePosted: posted || undefined,
      company: company || undefined,
      source: "text",
      // NOTE: no fabricated url — text-detected jobs have no reliable link.
      // The DOM detector captures real posting URLs separately.
    });

    if (jobs.length >= 40) break;
  }

  return jobs;
}

/* DOM-based job card detection: look for repeated structures containing
   a link + text resembling a job title + nearby location-ish text. */
export function detectJobsFromDom(
  html: string,
  pageUrl: string,
): JobPosting[] {
  const $ = cheerio.load(html);
  const jobs: JobPosting[] = [];
  const seen = new Set<string>();

  // Common job-card selectors across ATS platforms
  const selectors = [
    "[class*='job-card']",
    "[class*='jobCard']",
    "[class*='job-result']",
    "[class*='jobResult']",
    "[data-job-id]",
    "[class*='pcs-job']",
    "article[class*='job']",
    "li[class*='job']",
    "div[class*='posting']",
    "div[class*='opening']",
    "[class*='position-card']",
    "[class*='career-card']",
  ];

  for (const sel of selectors) {
    if (jobs.length >= 40) break;
    const cards = $(sel);
    if (cards.length < 2) continue;
    cards.each((_, el) => {
      if (jobs.length >= 40) return;
      const $el = $(el);
      const link = $el.find("a[href]").first();
      const title =
        $el.find("[class*='title'], h2, h3, h4, a").first().text().trim() ||
        link.text().trim();
      if (!title || title.length < 5 || title.length > 160) return;
      const href = link.attr("href") || "";
      const url = href ? abs(href, pageUrl) : "";
      const body = $el.text().replace(/\s+/g, " ").trim();
      const locMatch = body.match(LOCATION_HINT);
      const postedMatch = body.match(POSTED_HINT);
      const lower = title.toLowerCase();
      const looksJob =
        JOB_KEYWORDS.some((k) => lower.includes(k)) ||
        /\b(role|position|job)\b/i.test(title);
      if (!looksJob) return;
      const key = title.toLowerCase() + "|" + (locMatch?.[0] ?? "");
      if (seen.has(key)) return;
      seen.add(key);
      jobs.push({
        title,
        url: url || undefined,
        location: locMatch?.[0] || undefined,
        datePosted: postedMatch?.[0].replace(/\s+/g, " ").trim() || undefined,
        source: "dom",
      });
    });
    if (jobs.length > 0) break; // use the first selector that yields results
  }

  return jobs;
}

export function mergeJobs(...lists: JobPosting[][]): JobPosting[] {
  const out: JobPosting[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const j of list) {
      const key = (
        j.title.toLowerCase() +
        "|" +
        (j.location || j.locationString || "").toLowerCase()
      ).trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(j);
    }
  }
  return out;
}