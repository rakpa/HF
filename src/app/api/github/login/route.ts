import { NextResponse } from "next/server";

export async function GET() {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) {
    return NextResponse.json(
      {
        error:
          "GitHub OAuth is not configured. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or set GITHUB_TOKEN (repo scope) on Vercel.",
      },
      { status: 400 },
    );
  }

  const state = crypto.randomUUID();
  const redirect = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(id)}&scope=${encodeURIComponent("repo read:user")}&state=${encodeURIComponent(state)}`;
  const response = NextResponse.redirect(redirect);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `hf_gh_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`,
  );
  return response;
}
