import { NextResponse } from "next/server";
import { githubJson, tokenFromRequest } from "@/lib/github";

export async function GET(req: Request) {
  const token = tokenFromRequest(req);
  const { searchParams } = new URL(req.url);
  const owner = searchParams.get("owner") ?? "";
  const repo = searchParams.get("repo") ?? "";
  if (!token || !owner || !repo) {
    return NextResponse.json({ error: "Connect GitHub and open a repo." }, { status: 400 });
  }
  const result = await githubJson<Array<{ name: string }>>(
    `https://api.github.com/repos/${owner}/${repo}/branches?per_page=50`,
    token,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ branches: result.data.map((item) => item.name) });
}

export async function POST(req: Request) {
  const token = tokenFromRequest(req);
  if (!token) {
    return NextResponse.json({ error: "Connect GitHub first." }, { status: 401 });
  }
  const body = await req.json();
  const owner = String(body.owner ?? "");
  const repo = String(body.repo ?? "");
  const from = String(body.from ?? "main");
  const name = String(body.name ?? "").trim();
  if (!owner || !repo || !name) {
    return NextResponse.json({ error: "Branch name required." }, { status: 400 });
  }

  const ref = await githubJson<{ object: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(from)}`,
    token,
  );
  if (!ref.ok) {
    return NextResponse.json({ error: `Could not read ${from}.` }, { status: ref.status });
  }

  const created = await githubJson<{ ref: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${name}`,
        sha: ref.data.object.sha,
      }),
    },
  );
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: created.status });
  }
  return NextResponse.json({ name });
}
