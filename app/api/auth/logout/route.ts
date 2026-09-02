import { getAuthToken, destroySession, clearAuthCookie } from "../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const token = await getAuthToken();
    if (token) await destroySession(token);
    await clearAuthCookie();
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Logout failed" },
      { status: 500 },
    );
  }
}