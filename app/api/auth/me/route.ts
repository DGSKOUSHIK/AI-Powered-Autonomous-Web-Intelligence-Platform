import { getCurrentUser } from "../../lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ user: null }, { status: 200 });
    return Response.json({ user });
  } catch {
    return Response.json({ user: null }, { status: 200 });
  }
}