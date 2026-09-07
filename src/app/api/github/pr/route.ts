import { NextResponse } from "next/server";
import { githubJson, tokenFromRequest } from "@/lib/github";

export async function POST(req: Request) {
  const token = tokenFromRequest(req);
  if (!token) {
    return NextResponse.json({ error: "Connect GitHub first." }, { status: 401 });
  }
  const body = await req.json();
  const owner = String(body.owner ?? "");
  const repo = String(body.repo ?? "");
  const title = String(body.title ?? "").trim() || "Changes from Forge";
  const head = String(body.head ?? "");
  const base = String(body.base ?? "main");
  const prBody = String(body.body ?? "");
  if (!owner || !repo || !head) {
    return NextResponse.json({ error: "Missing pull request fields." }, { status: 400 });
  }

  const created = await githubJson<{ html_url: string; number: number }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, head, base, body: prBody }),
    },
  );
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status });
  }
  return NextResponse.json({ url: created.data.html_url, number: created.data.number });
}
