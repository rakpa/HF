import { NextResponse } from "next/server";
import { isSkippedPath, MAX_FILE_BYTES } from "@/lib/files";

export async function POST(req: Request) {
  let owner = "";
  let repo = "";
  let branch = "";
  let path = "";
  try {
    const body = await req.json();
    owner = String(body.owner ?? "");
    repo = String(body.repo ?? "");
    branch = String(body.branch ?? "main");
    path = String(body.path ?? "");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!owner || !repo || !path || path.includes("..") || isSkippedPath(path)) {
    return NextResponse.json({ error: "Invalid file path." }, { status: 400 });
  }

  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "codeforge" },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Could not fetch ${path} (${res.status}).` },
      { status: res.status },
    );
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "File is larger than 200 KB." }, { status: 413 });
  }

  return NextResponse.json({
    path,
    content: new TextDecoder().decode(buf),
  });
}
