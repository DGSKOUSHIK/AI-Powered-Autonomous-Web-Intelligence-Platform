import { pingDb } from "../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:e2b";

export async function GET() {
  const checks: Record<string, "ok" | "down"> = {
    ollama: "down",
    mongodb: "down",
  };

  // Ollama: list models and confirm the configured model is present.
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models || []).map((m) => m.name);
      // accept exact match or a tag prefix (e.g. "gemma4:e2b" matches "gemma4:e2b:latest")
      const found = names.some(
        (n) => n === OLLAMA_MODEL || n.startsWith(OLLAMA_MODEL + ":"),
      );
      checks.ollama = found ? "ok" : "down";
    }
  } catch {
    // leave as down
  }

  // MongoDB
  try {
    checks.mongodb = (await pingDb()) ? "ok" : "down";
  } catch {
    // leave as down
  }

  const allOk = Object.values(checks).every((s) => s === "ok");
  return Response.json(
    {
      status: allOk ? "ok" : "degraded",
      checks,
      ollamaHost: OLLAMA_HOST,
      model: OLLAMA_MODEL,
    },
    { status: allOk ? 200 : 503 },
  );
}