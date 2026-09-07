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
export const MAX_FILES = 200;
export const MAX_CONTEXT_CHARS = 120_000;

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
  if (!files.length) return "";
  const index = `The workspace contains ${files.length} file(s). You can read and edit any of them:\n${files.map((file) => `- ${file.path}`).join("\n")}`;
  let used = index.length;
  const chunks: string[] = [index];
  for (const file of files) {
    const block = `\n\nFile: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``;
    if (used + block.length > MAX_CONTEXT_CHARS) {
      chunks.push(`\n\n[${file.path} is in the workspace but omitted from this prompt for size. Ask to open it if you need the full contents.]`);
      continue;
    }
    chunks.push(block);
    used += block.length;
  }
  return chunks.join("");
}

export type ProposedFile = { path: string; content: string; action: "create" | "edit" | "delete" };

export type AgentRun = { cmd: string };

export function parseProposedFiles(text: string): ProposedFile[] {
  const found: ProposedFile[] = [];
  const tagged = /<file\s+path="([^"]+)"(?:\s+action="(create|edit|delete)")?\s*>([\s\S]*?)<\/file>/g;
  for (const match of text.matchAll(tagged)) {
    const action = (match[2] as ProposedFile["action"] | undefined) ?? "edit";
    found.push({
      path: match[1],
      content: match[3].replace(/^\n|\n$/g, ""),
      action,
    });
  }
  const fenced = /```(?:[\w.+-]+)?(?::| )\s*([^\s\n]+)\n([\s\S]*?)```/g;
  for (const match of text.matchAll(fenced)) {
    const path = match[1].trim();
    if (!path.includes("/") && !path.includes(".")) continue;
    if (found.some((item) => item.path === path)) continue;
    found.push({ path, content: match[2].replace(/\n$/, ""), action: "edit" });
  }
  return found;
}

export function parseAgentRuns(text: string): AgentRun[] {
  const runs: AgentRun[] = [];
  for (const match of text.matchAll(/<run\s+cmd="([^"]+)"\s*\/>/g)) {
    runs.push({ cmd: match[1] });
  }
  for (const match of text.matchAll(/<run(?:\s+cmd="([^"]+)")?\s*>([\s\S]*?)<\/run>/g)) {
    const cmd = (match[1] || match[2]).trim();
    if (cmd) runs.push({ cmd });
  }
  for (const match of text.matchAll(/<command>([\s\S]*?)<\/command>/g)) {
    const cmd = match[1].trim();
    if (cmd) runs.push({ cmd });
  }
  return runs;
}
