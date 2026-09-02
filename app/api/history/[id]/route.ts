import { NextRequest } from "next/server";
import {
  getCurrentUser,
  getSession,
  deleteSession,
  renameSession,
} from "../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/history/[id]">,
) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await ctx.params;
    const session = await getSession(id, user.id);
    if (!session) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ session });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "db error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<"/api/history/[id]">,
) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await ctx.params;
    await deleteSession(id, user.id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "db error" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<"/api/history/[id]">,
) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await ctx.params;
    let body: { title?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (body.title && typeof body.title === "string") {
      await renameSession(id, user.id, body.title);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "db error" },
      { status: 500 },
    );
  }
}