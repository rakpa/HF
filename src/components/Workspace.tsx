"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  type WorkspaceFile,
  isSkippedPath,
  parseProposedFiles,
} from "@/lib/files";
import { DEFAULT_MODEL, MODELS, type ModelId } from "@/lib/models";

type ChatRole = "user" | "assistant";
type ChatMessage = { id: string; role: ChatRole; content: string; applied?: string[] };
type GithubRepo = { owner: string; repo: string; branch: string };
type GhUser = { login: string; avatar?: string };
type GhRepo = { fullName: string; private: boolean; branch: string };

function uid(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function treeFromFiles(paths: string[]): Record<string, string[]> {
  const dirs: Record<string, string[]> = { "": [] };
  for (const path of paths) {
    const parts = path.split("/");
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      const parent = current;
      const name = parts[i];
      const next = joinPath(parent, name);
      if (!dirs[parent]) dirs[parent] = [];
      if (!dirs[parent].includes(name)) dirs[parent].push(name);
      if (i < parts.length - 1 && !dirs[next]) dirs[next] = [];
      current = next;
    }
  }
  for (const key of Object.keys(dirs)) {
    dirs[key].sort((a, b) => {
      const aDir = Boolean(dirs[joinPath(key, a)]);
      const bDir = Boolean(dirs[joinPath(key, b)]);
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
  }
  return dirs;
}

export function Workspace() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(true);
  const [ghUser, setGhUser] = useState<GhUser | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[]>([]);
  const [pat, setPat] = useState("");
  const [oauth, setOauth] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const dirty = files.filter((file) => originals[file.path] !== file.content);
  const dirs = useMemo(
    () => treeFromFiles([...new Set([...files.map((f) => f.path), ...repoFiles])]),
    [files, repoFiles],
  );
  const active = files.find((file) => file.path === activePath) ?? null;

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    void refreshGithub();
  }, []);

  async function refreshGithub() {
    const res = await fetch("/api/github/status");
    const data = await res.json();
    setOauth(Boolean(data.oauth));
    if (data.connected && data.user) {
      setGhUser(data.user);
      const list = await fetch("/api/github/repos");
      const payload = await list.json();
      if (list.ok) setGhRepos(payload.repos ?? []);
    } else {
      setGhUser(null);
      setGhRepos([]);
    }
  }

  function upsertFile(next: WorkspaceFile, open = true) {
    setFiles((prev) => {
      const rest = prev.filter((file) => file.path !== next.path);
      return [...rest, next].sort((a, b) => a.path.localeCompare(b.path));
    });
    setOriginals((prev) => (next.path in prev ? prev : { ...prev, [next.path]: next.content }));
    if (open) setActivePath(next.path);
  }

  async function onUpload(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    for (const file of Array.from(list).slice(0, MAX_FILES)) {
      const path = (file.webkitRelativePath || file.name).replace(/^\.\//, "");
      if (isSkippedPath(path) || file.size > MAX_FILE_BYTES) continue;
      upsertFile({ path, content: await file.text(), source: "upload" });
    }
  }

  async function openRepo(input: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/github/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open repo.");
      const nextRepo = { owner: data.owner, repo: data.repo, branch: data.branch };
      setRepo(nextRepo);
      setRepoFiles(data.files as string[]);
      setFiles([]);
      setOriginals({});
      setActivePath(null);
      setMessages([]);
      await hydrateRepo(nextRepo, data.files as string[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open repo.");
    } finally {
      setBusy(false);
    }
  }

  async function hydrateRepo(target: GithubRepo, paths: string[]) {
    const preferred = paths
      .filter((path) => /\.(ts|tsx|js|jsx|py|go|rs|md|json|css|html)$/i.test(path))
      .slice(0, 20);
    for (const path of preferred) {
      await loadRepoFile(target, path, false);
    }
  }

  async function loadRepoFile(target: GithubRepo, path: string, open = true) {
    const existing = files.find((file) => file.path === path);
    if (existing) {
      if (open) setActivePath(path);
      return existing;
    }
    setLoadingPath(path);
    try {
      const res = await fetch("/api/github/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target, path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load file.");
      const next = { path, content: data.content as string, source: "github" as const };
      upsertFile(next, open);
      return next;
    } finally {
      setLoadingPath(null);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const userMessage: ChatMessage = { id: uid(), role: "user", content: text };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setBusy(true);
    setError(null);

    let contextFiles = [...files];
    if (repo) {
      const mentioned = repoFiles.filter((path) => text.includes(path) || text.includes(path.split("/").pop() ?? ""));
      for (const path of mentioned.slice(0, 8)) {
        if (!contextFiles.some((file) => file.path === path)) {
          try {
            const loaded = await loadRepoFile(repo, path, false);
            if (loaded) contextFiles = [...contextFiles.filter((f) => f.path !== loaded.path), loaded];
          } catch {
            // continue with files already in memory
          }
        }
      }
    }

    const assistantId = uid();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          files: contextFiles,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Chat failed." }));
        throw new Error(data.error || "Chat failed.");
      }
      if (!res.body) throw new Error("No response stream.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n");
        buffer = chunks.pop() ?? "";
        for (const line of chunks) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
            };
            const piece = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.delta?.reasoning_content ?? "";
            if (!piece) continue;
            assembled += piece;
            const snapshot = assembled;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: snapshot } : message,
              ),
            );
          } catch {
            // ignore malformed SSE
          }
        }
      }

      const proposed = parseProposedFiles(assembled);
      for (const item of proposed) {
        upsertFile(
          {
            path: item.path,
            content: item.content,
            source: contextFiles.find((file) => file.path === item.path)?.source ?? (repo ? "github" : "upload"),
          },
          false,
        );
      }
      if (proposed.length) {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? { ...message, applied: proposed.map((item) => item.path) }
              : message,
          ),
        );
        setCommitMessage(text.slice(0, 72));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat failed.";
      setError(message);
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantId && !item.content ? { ...item, content: `Error: ${message}` } : item,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function commitToGithub() {
    if (!repo || dirty.length === 0) return;
    setCommitting(true);
    setError(null);
    try {
      const res = await fetch("/api/github/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...repo,
          message: commitMessage || "Update from Forge",
          files: dirty.map((file) => ({ path: file.path, content: file.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Commit failed.");
      setOriginals((prev) => {
        const next = { ...prev };
        for (const file of dirty) next[file.path] = file.content;
        return next;
      });
      setNotice(`Committed ${data.sha?.slice(0, 7)} to ${repo.owner}/${repo.repo}`);
      setCommitMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed.");
    } finally {
      setCommitting(false);
    }
  }

  async function savePat(event: React.FormEvent) {
    event.preventDefault();
    const res = await fetch("/api/github/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: pat }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not save token.");
      return;
    }
    setPat("");
    await refreshGithub();
  }

  const emptyChat = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      <aside
        className={`${sidebar ? "flex" : "hidden"} w-[280px] shrink-0 flex-col border-r border-line bg-panel md:flex`}
      >
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-[11px] font-bold text-[#0b0c10]">
            HF
          </span>
          <span className="text-[15px] font-medium tracking-tight">Forge</span>
        </div>

        <div className="space-y-3 border-b border-line px-3 pb-3">
          {ghUser ? (
            <div className="flex items-center justify-between rounded-lg border border-line bg-panel-2 px-2.5 py-2">
              <p className="truncate text-[12px]">@{ghUser.login}</p>
              <button
                type="button"
                className="text-[11px] text-muted"
                onClick={() => void fetch("/api/github/session", { method: "DELETE" }).then(refreshGithub)}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {oauth ? (
                <a
                  href="/api/github/login"
                  className="block rounded-lg bg-foreground py-2 text-center text-[13px] font-medium text-background"
                >
                  Connect GitHub
                </a>
              ) : null}
              <form onSubmit={savePat} className="space-y-1.5">
                <input
                  value={pat}
                  onChange={(event) => setPat(event.target.value)}
                  placeholder="GitHub token (repo scope)"
                  type="password"
                  className="w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[12px] outline-none"
                />
                <button type="submit" className="w-full rounded-lg border border-line py-1.5 text-[12px]">
                  Connect with token
                </button>
              </form>
            </div>
          )}

          {ghRepos.length ? (
            <select
              value={repo ? `${repo.owner}/${repo.repo}` : ""}
              onChange={(event) => {
                if (event.target.value) void openRepo(event.target.value);
              }}
              className="w-full rounded-lg border border-line bg-panel-2 px-2 py-2 text-[12px] outline-none"
            >
              <option value="">Open a repository</option>
              {ghRepos.map((item) => (
                <option key={item.fullName} value={item.fullName}>
                  {item.fullName}
                </option>
              ))}
            </select>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (repoInput.trim()) void openRepo(repoInput);
              }}
              className="flex gap-1"
            >
              <input
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder="owner/repo"
                className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-2 py-2 text-[12px] outline-none"
              />
              <button type="submit" className="rounded-lg border border-line px-2 text-[12px]">
                Open
              </button>
            </form>
          )}

          <div className="flex gap-1">
            <button type="button" onClick={() => uploadRef.current?.click()} className="flex-1 rounded-lg border border-line py-1.5 text-[12px]">
              Upload
            </button>
            <button type="button" onClick={() => folderRef.current?.click()} className="flex-1 rounded-lg border border-line py-1.5 text-[12px]">
              Folder
            </button>
          </div>
          <input ref={uploadRef} type="file" multiple className="hidden" onChange={(e) => void onUpload(e.target.files)} />
          <input ref={folderRef} type="file" multiple className="hidden" onChange={(e) => void onUpload(e.target.files)} />
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-2">
          {repo ? (
            <p className="px-3 pb-2 font-mono text-[11px] text-muted">
              {repo.owner}/{repo.repo}@{repo.branch}
            </p>
          ) : null}
          {repoFiles.length === 0 && files.length === 0 ? (
            <p className="px-3 text-[12px] leading-5 text-muted">
              Connect GitHub like Cursor. The agent reads the repo, edits files, then you commit back.
            </p>
          ) : (
            <FileNodes
              parent=""
              dirs={dirs}
              files={files}
              repoFiles={repoFiles}
              activePath={activePath}
              collapsed={collapsed}
              dirty={new Set(dirty.map((file) => file.path))}
              loadingPath={loadingPath}
              onOpen={(path) => {
                if (files.some((file) => file.path === path)) setActivePath(path);
                else if (repo) void loadRepoFile(repo, path, true);
              }}
              onToggleDir={(path) => {
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                });
              }}
            />
          )}
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 px-4">
          <button type="button" className="text-muted md:hidden" onClick={() => setSidebar((v) => !v)}>
            Menu
          </button>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value as ModelId)}
            className="rounded-full border border-line bg-transparent px-3 py-1 text-[13px] outline-none"
          >
            {MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="ml-auto text-[12px] text-muted">
            {repo ? `${repo.owner}/${repo.repo}` : "No repo"}
            {dirty.length ? ` · ${dirty.length} changed` : ""}
          </span>
        </header>

        {error ? <p className="px-4 pb-2 text-center text-[13px] text-[#f0b4b4]">{error}</p> : null}
        {notice ? <p className="px-4 pb-2 text-center text-[13px] text-accent">{notice}</p> : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {emptyChat ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4">
              <h1 className="mb-8 text-center text-[28px] font-medium tracking-tight">
                {repo ? `What should we change in ${repo.repo}?` : "What do you want to build?"}
              </h1>
              <Composer
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                onSend={() => void send()}
                composerRef={composerRef}
                wide
              />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[48rem] flex-1 px-4 py-6">
              {messages.map((message) => (
                <article key={message.id} className="mb-8">
                  <p className="mb-2 text-[12px] font-medium text-muted">
                    {message.role === "user" ? "You" : "Forge"}
                  </p>
                  <pre className="whitespace-pre-wrap font-sans text-[16px] leading-7">
                    {message.content.replace(/<file\s+path="[^"]+">[\s\S]*?<\/file>/g, (block) => {
                      const path = block.match(/path="([^"]+)"/)?.[1] ?? "file";
                      return `\nUpdated ${path}\n`;
                    }) || (busy ? "" : "…")}
                  </pre>
                  {message.applied?.length ? (
                    <p className="mt-3 text-[13px] text-accent">
                      Applied {message.applied.join(", ")}. Review in the sidebar, then commit to GitHub.
                    </p>
                  ) : null}
                </article>
              ))}
              {busy ? <p className="text-[13px] text-muted">Thinking</p> : null}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        {emptyChat ? null : (
          <div className="mx-auto w-full max-w-[48rem] px-4 pb-5">
            {dirty.length && repo ? (
              <div className="mb-3 flex gap-2 rounded-2xl border border-line bg-panel px-3 py-2">
                <input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={`Commit ${dirty.length} file${dirty.length === 1 ? "" : "s"} to GitHub`}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                />
                <button
                  type="button"
                  disabled={committing}
                  onClick={() => void commitToGithub()}
                  className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-[#0b0c10] disabled:opacity-40"
                >
                  {committing ? "Pushing…" : "Commit & push"}
                </button>
              </div>
            ) : null}
            <Composer
              draft={draft}
              setDraft={setDraft}
              busy={busy}
              onSend={() => void send()}
              composerRef={composerRef}
            />
          </div>
        )}

        {active ? (
          <div className="absolute inset-0 z-10 flex flex-col bg-background/95">
            <div className="flex h-14 items-center gap-3 border-b border-line px-4">
              <p className="font-mono text-[13px]">{active.path}</p>
              <button type="button" className="ml-auto text-[13px] text-muted" onClick={() => setActivePath(null)}>
                Back to chat
              </button>
            </div>
            <textarea
              value={active.content}
              onChange={(event) =>
                setFiles((prev) =>
                  prev.map((file) =>
                    file.path === active.path ? { ...file, content: event.target.value } : file,
                  ),
                )
              }
              spellCheck={false}
              className="editor-input min-h-0 flex-1 resize-none bg-transparent p-6 text-foreground outline-none"
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}

function Composer({
  draft,
  setDraft,
  busy,
  onSend,
  composerRef,
  wide = false,
}: {
  draft: string;
  setDraft: (value: string) => void;
  busy: boolean;
  onSend: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  wide?: boolean;
}) {
  return (
    <form
      className={`w-full ${wide ? "max-w-[48rem]" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <div className="rounded-[28px] border border-line bg-panel-2 px-4 pt-3 pb-2 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]">
        <textarea
          ref={composerRef}
          value={draft}
          rows={wide ? 3 : 2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Message Forge"
          className="w-full resize-none bg-transparent text-[16px] leading-6 outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between pb-1">
          <p className="text-[11px] text-muted">Enter to send</p>
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="grid h-8 w-8 place-items-center rounded-full bg-foreground text-background disabled:opacity-25"
            aria-label="Send"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11.5V2.5M7 2.5 3 6.5M7 2.5l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
}

function FileNodes({
  parent,
  dirs,
  files,
  repoFiles,
  activePath,
  collapsed,
  dirty,
  loadingPath,
  onOpen,
  onToggleDir,
}: {
  parent: string;
  dirs: Record<string, string[]>;
  files: WorkspaceFile[];
  repoFiles: string[];
  activePath: string | null;
  collapsed: Set<string>;
  dirty: Set<string>;
  loadingPath: string | null;
  onOpen: (path: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const names = dirs[parent] ?? [];
  return (
    <ul className={parent ? "ml-2" : "px-1"}>
      {names.map((name) => {
        const path = joinPath(parent, name);
        const isDir = Boolean(dirs[path]);
        if (isDir) {
          const isCollapsed = collapsed.has(path);
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => onToggleDir(path)}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[13px] text-muted hover:bg-white/4"
              >
                {name}
              </button>
              {isCollapsed ? null : (
                <FileNodes
                  parent={path}
                  dirs={dirs}
                  files={files}
                  repoFiles={repoFiles}
                  activePath={activePath}
                  collapsed={collapsed}
                  dirty={dirty}
                  loadingPath={loadingPath}
                  onOpen={onOpen}
                  onToggleDir={onToggleDir}
                />
              )}
            </li>
          );
        }
        const listed = files.some((file) => file.path === path) || repoFiles.includes(path);
        if (!listed) return null;
        return (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[13px] ${
                activePath === path ? "bg-accent-dim text-accent" : "text-foreground/90 hover:bg-white/4"
              }`}
            >
              <span className="truncate">{loadingPath === path ? "Loading…" : name}</span>
              {dirty.has(path) ? <span className="text-accent">•</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
