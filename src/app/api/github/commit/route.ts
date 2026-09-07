import { NextResponse } from "next/server";
import { githubJson, tokenFromRequest } from "@/lib/github";

type Body = {
  owner?: string;
  repo?: string;
  branch?: string;
  message?: string;
  files?: Array<{ path: string; content: string }>;
};

export async function POST(req: Request) {
  const token = tokenFromRequest(req);
  if (!token) {
    return NextResponse.json(
      { error: "Connect GitHub (OAuth or a repo-scoped token) to commit." },
      { status: 401 },
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const owner = String(body.owner ?? "");
  const repo = String(body.repo ?? "");
  const branch = String(body.branch ?? "main");
  const message = String(body.message ?? "").trim() || "Update from HF Forge";
  const files = Array.isArray(body.files) ? body.files : [];

  if (!owner || !repo || files.length === 0) {
    return NextResponse.json({ error: "Nothing to commit." }, { status: 400 });
  }
  if (files.some((file) => !file.path || file.path.includes(".."))) {
    return NextResponse.json({ error: "Invalid file path." }, { status: 400 });
  }

  const ref = await githubJson<{ object: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    token,
  );
  if (!ref.ok) {
    return NextResponse.json({ error: `Could not read branch ${branch}.` }, { status: ref.status });
  }

  const parent = await githubJson<{ tree: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${ref.data.object.sha}`,
    token,
  );
  if (!parent.ok) {
    return NextResponse.json({ error: "Could not read HEAD commit." }, { status: parent.status });
  }

  const tree = await githubJson<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: parent.data.tree.sha,
        tree: files.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.content,
        })),
      }),
    },
  );
  if (!tree.ok) {
    return NextResponse.json({ error: tree.error }, { status: tree.status });
  }

  const commit = await githubJson<{ sha: string; html_url?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        tree: tree.data.sha,
        parents: [ref.data.object.sha],
      }),
    },
  );
  if (!commit.ok) {
    return NextResponse.json({ error: commit.error }, { status: commit.status });
  }

  const moved = await githubJson<{ url: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commit.data.sha }),
    },
  );
  if (!moved.ok) {
    return NextResponse.json({ error: moved.error }, { status: moved.status });
  }

  return NextResponse.json({
    sha: commit.data.sha,
    url: commit.data.html_url ?? `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
  });
}
