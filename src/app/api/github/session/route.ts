import { NextResponse } from "next/server";
import { clearTokenCookie, tokenCookie } from "@/lib/github";

export async function POST(req: Request) {
  let token = "";
  try {
    const body = await req.json();
    token = String(body.token ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    return NextResponse.json(
      { error: "Paste a GitHub personal access token with the repo scope." },
      { status: 400 },
    );
  }
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", tokenCookie(token));
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearTokenCookie());
  return response;
}
