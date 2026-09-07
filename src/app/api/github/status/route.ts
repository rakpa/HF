import { NextResponse } from "next/server";
import { githubJson, tokenFromRequest } from "@/lib/github";

export async function GET(req: Request) {
  const token = tokenFromRequest(req);
  const oauth = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  if (!token) {
    return NextResponse.json({ connected: false, oauth, user: null });
  }

  const result = await githubJson<{ login: string; avatar_url?: string }>(
    "https://api.github.com/user",
    token,
  );
  if (!result.ok) {
    return NextResponse.json({ connected: false, oauth, user: null, error: result.error });
  }

  return NextResponse.json({
    connected: true,
    oauth,
    user: { login: result.data.login, avatar: result.data.avatar_url },
  });
}
