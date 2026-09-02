import { listSessions, createSession, getCurrentUser } from "../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const sessions = await listSessions(user.id, 50);
    return Response.json({ sessions });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "db error" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const id = await createSession(user.id, "New analysis");
    return Response.json({ id });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "db error" },
      { status: 500 },
    );
  }
}