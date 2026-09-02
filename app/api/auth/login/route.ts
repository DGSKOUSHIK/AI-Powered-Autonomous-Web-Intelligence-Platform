import { NextRequest } from "next/server";
import {
  verifyUser,
  createAuthToken,
  setAuthCookie,
} from "../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const username = (body.username || "").trim();
  const password = body.password || "";

  if (!username || !password) {
    return Response.json({ error: "Username and password are required" }, { status: 400 });
  }

  try {
    const user = await verifyUser(username, password);
    if (!user) {
      return Response.json({ error: "Invalid username or password" }, { status: 401 });
    }
    const token = await createAuthToken(user.id);
    await setAuthCookie(token);
    return Response.json({ id: user.id, username: user.username });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Login failed" },
      { status: 500 },
    );
  }
}