import { NextResponse } from "next/server";
import { isSkippedPath, MAX_FILES, parseGithubRepo } from "@/lib/files";

export async function POST(req: Request) {
  let input = "";
  try {
    const body = await req.json();
    input = String(body.repo ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = parseGithubRepo(input);
  if (!parsed) {
    return NextResponse.json(
      { error: "Use a GitHub URL or owner/repo, e.g. facebook/react" },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "codeforge",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const repoRes = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
    { headers, cache: "no-store" },
  );
  if (!repoRes.ok) {
    const status = repoRes.status;
    const error =
      status === 404
        ? "Repository not found. For private repos, set GITHUB_TOKEN."
        : status === 403
          ? "GitHub rate limit hit. Add GITHUB_TOKEN to raise it."
          : `GitHub returned ${status}.`;
    return NextResponse.json({ error }, { status });
  }

  const repo = (await repoRes.json()) as { default_branch?: string };
  const branch = repo.default_branch || "main";

  const treeRes = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers, cache: "no-store" },
  );
  if (!treeRes.ok) {
    return NextResponse.json(
      { error: `Could not list files (${treeRes.status}).` },
      { status: treeRes.status },
    );
  }

  const payload = (await treeRes.json()) as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  };
  const files = (payload.tree ?? [])
    .filter((item) => item.type === "blob" && item.path && !isSkippedPath(item.path))
    .filter((item) => (item.size ?? 0) <= 200_000)
    .slice(0, MAX_FILES)
    .map((item) => item.path as string);

  return NextResponse.json({
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    files,
  });
}
