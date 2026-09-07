import { NextResponse } from "next/server";
import { isSkippedPath, MAX_FILES, parseGithubRepo } from "@/lib/files";
import { githubJson, tokenFromRequest } from "@/lib/github";

export async function POST(req: Request) {
  const token = tokenFromRequest(req);
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

  const repoRes = await githubJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
    token,
  );
  if (!repoRes.ok) {
    const error =
      repoRes.status === 404
        ? "Repository not found. Connect GitHub to open private repos."
        : repoRes.status === 403
          ? "GitHub rate limit or permission error. Connect GitHub with repo scope."
          : `GitHub returned ${repoRes.status}.`;
    return NextResponse.json({ error }, { status: repoRes.status });
  }

  const branch = repoRes.data.default_branch || "main";
  const treeRes = await githubJson<{
    tree?: Array<{ path?: string; type?: string; size?: number }>;
  }>(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    token,
  );
  if (!treeRes.ok) {
    return NextResponse.json(
      { error: `Could not list files (${treeRes.status}).` },
      { status: treeRes.status },
    );
  }

  const files = (treeRes.data.tree ?? [])
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
