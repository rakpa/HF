import { NextRequest, NextResponse } from "next/server";
import { parseCookie, tokenCookie } from "@/lib/github";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookie(req.headers.get("cookie"), "hf_gh_state");
  const origin = url.origin;

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(`${origin}/?github=denied`);
  }

  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) {
    return NextResponse.redirect(`${origin}/?github=missing_oauth`);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      code,
    }),
  });
  const payload = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!payload.access_token) {
    return NextResponse.redirect(`${origin}/?github=token_failed`);
  }

  const response = NextResponse.redirect(`${origin}/?github=connected`);
  response.headers.append("Set-Cookie", tokenCookie(payload.access_token));
  response.headers.append(
    "Set-Cookie",
    `hf_gh_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  return response;
}
