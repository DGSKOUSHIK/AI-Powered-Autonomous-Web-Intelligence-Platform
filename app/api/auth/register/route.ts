import { NextRequest } from "next/server";
import {
  createUser,
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
    const user = await createUser(username, password);
    const token = await createAuthToken(user.id);
    await setAuthCookie(token);
    return Response.json({ id: user.id, username: user.username });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Registration failed";
    const status = msg.includes("already taken") ? 409 : 400;
    return Response.json({ error: msg }, { status });
  }
}