import { NextResponse } from "next/server";
import { clearTokenCookie, githubJson, tokenCookie } from "@/lib/github";

function normalizeToken(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, "");
}

function looksLikeGithubToken(token: string): boolean {
  return /^(ghp_|github_pat_|gho_|ghu_|ghs_)/.test(token) || token.length >= 20;
}

export async function POST(req: Request) {
  let token = "";
  try {
    const body = await req.json();
    token = normalizeToken(String(body.token ?? ""));
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json(
      { error: "Paste a GitHub personal access token with the repo scope." },
      { status: 400 },
    );
  }
  if (!looksLikeGithubToken(token)) {
    return NextResponse.json(
      { error: "That does not look like a GitHub token. Create one at github.com/settings/tokens (repo scope)." },
      { status: 400 },
    );
  }

  const user = await githubJson<{ login: string }>("https://api.github.com/user", token);
  if (!user.ok) {
    return NextResponse.json(
      {
        error:
          "GitHub rejected this token. Use a classic token with repo scope, or a fine-grained token with Contents: Read and write plus Pull requests.",
      },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true, user: { login: user.data.login } });
  response.headers.set("Set-Cookie", tokenCookie(token));
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.headers.set("Set-Cookie", clearTokenCookie());
  return response;
}
