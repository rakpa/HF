import { NextResponse } from "next/server";
import { githubJson, tokenFromRequest } from "@/lib/github";

export async function GET(req: Request) {
  const token = tokenFromRequest(req);
  if (!token) {
    return NextResponse.json({ error: "Connect GitHub first." }, { status: 401 });
  }

  const result = await githubJson<Array<{ full_name: string; private: boolean; default_branch: string }>>(
    "https://api.github.com/user/repos?per_page=50&sort=updated&affiliation=owner,collaborator",
    token,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    repos: result.data.map((repo) => ({
      fullName: repo.full_name,
      private: repo.private,
      branch: repo.default_branch,
    })),
  });
}
