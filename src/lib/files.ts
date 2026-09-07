export type WorkspaceFile = {
  path: string;
  content: string;
  source: "upload" | "github";
};

export const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "tar",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "mp3",
  "mp4",
  "mov",
  "wav",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "lockb",
]);

export const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "vendor",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
]);

export const MAX_FILE_BYTES = 200_000;
export const MAX_FILES = 80;
export const MAX_CONTEXT_CHARS = 80_000;

export function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}

export function isSkippedPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.some((part) => SKIP_DIR.has(part))) return true;
  if (BINARY_EXT.has(extOf(path))) return true;
  return false;
}

export function parseGithubRepo(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  const match = trimmed.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)|^(?:\/)?([^/\s]+)\/([^/\s#?]+)$/i,
  );
  if (!match) return null;
  const owner = match[1] ?? match[3];
  const repo = (match[2] ?? match[4])?.replace(/\.git$/, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function buildFileContext(files: WorkspaceFile[]): string {
  let used = 0;
  const chunks: string[] = [];
  for (const file of files) {
    const block = `File: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``;
    if (used + block.length > MAX_CONTEXT_CHARS) break;
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("\n\n");
}

export type ProposedFile = { path: string; content: string };

export function parseProposedFiles(text: string): ProposedFile[] {
  const found: ProposedFile[] = [];
  const tagged = /<file\s+path="([^"]+)">([\s\S]*?)<\/file>/g;
  for (const match of text.matchAll(tagged)) {
    found.push({ path: match[1], content: match[2].replace(/^\n|\n$/g, "") });
  }
  const fenced =
    /```(?:[\w.+-]+)?(?::| )\s*([^\s\n]+)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) {
    const path = match[1].trim();
    if (!path.includes("/") && !path.includes(".")) continue;
    if (found.some((item) => item.path === path)) continue;
    found.push({ path, content: match[2].replace(/\n$/, "") });
  }
  return found;
}
