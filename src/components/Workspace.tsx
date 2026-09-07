"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  type WorkspaceFile,
  extOf,
  isSkippedPath,
  parseProposedFiles,
} from "@/lib/files";
import { DEFAULT_MODEL, MODELS, type ModelId } from "@/lib/models";

type ChatRole = "user" | "assistant";
type ChatMessage = { id: string; role: ChatRole; content: string };
type GithubRepo = { owner: string; repo: string; branch: string };
type Tab = "files" | "chat";

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

function languageHint(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TSX",
    js: "JavaScript",
    jsx: "JSX",
    py: "Python",
    rs: "Rust",
    go: "Go",
    json: "JSON",
    md: "Markdown",
    css: "CSS",
    html: "HTML",
  };
  return map[ext] ?? (ext.toUpperCase() || "Text");
}

export function Workspace() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<Tab>("files");
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const active = files.find((file) => file.path === activePath) ?? null;
  const lineCount = active ? Math.max(active.content.split("\n").length, 1) : 1;
  const dirs = useMemo(
    () => treeFromFiles([...new Set([...files.map((f) => f.path), ...repoFiles])]),
    [files, repoFiles],
  );
  const modelMeta = MODELS.find((item) => item.id === model);

  function upsertFile(next: WorkspaceFile) {
    setFiles((prev) => {
      const rest = prev.filter((file) => file.path !== next.path);
      return [...rest, next].sort((a, b) => a.path.localeCompare(b.path));
    });
    setActivePath(next.path);
  }

  async function onUpload(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    const incoming = Array.from(list).slice(0, MAX_FILES);
    for (const file of incoming) {
      const path = (file.webkitRelativePath || file.name).replace(/^\.\//, "");
      if (isSkippedPath(path) || file.size > MAX_FILE_BYTES) continue;
      const content = await file.text();
      upsertFile({ path, content, source: "upload" });
    }
    setMobileTab("files");
  }

  async function connectRepo(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/github/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not connect repo.");
      setRepo({ owner: data.owner, repo: data.repo, branch: data.branch });
      setRepoFiles(data.files as string[]);
      setFiles((prev) => prev.filter((file) => file.source !== "github"));
      setActivePath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect repo.");
    } finally {
      setBusy(false);
    }
  }

  async function openRepoFile(path: string) {
    const existing = files.find((file) => file.path === path);
    if (existing) {
      setActivePath(path);
      return;
    }
    if (!repo) return;
    setLoadingPath(path);
    setError(null);
    try {
      const res = await fetch("/api/github/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...repo, path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load file.");
      upsertFile({ path, content: data.content, source: "github" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load file.");
    } finally {
      setLoadingPath(null);
    }
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleCollapsed(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
    setMobileTab("chat");

    const contextFiles = files.filter(
      (file) => file.path === activePath || selected.has(file.path),
    );

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
              choices?: Array<{
                delta?: { content?: string | null; reasoning_content?: string | null };
              }>;
            };
            const delta = json.choices?.[0]?.delta;
            const piece = delta?.content ?? delta?.reasoning_content ?? "";
            if (!piece) continue;
            assembled += piece;
            const snapshot = assembled;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: snapshot } : message,
              ),
            );
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat failed.";
      setError(message);
      setMessages((prev) =>
        prev.map((item) =>
          item.id === assistantId && !item.content
            ? { ...item, content: `Error: ${message}` }
            : item,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  function applyProposal(path: string, content: string) {
    upsertFile({
      path,
      content,
      source: files.find((file) => file.path === path)?.source ?? "upload",
    });
  }

  function updateActive(content: string) {
    if (!activePath) return;
    setFiles((prev) =>
      prev.map((file) => (file.path === activePath ? { ...file, content } : file)),
    );
  }

  function removeFile(path: string) {
    setFiles((prev) => prev.filter((file) => file.path !== path));
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    if (activePath === path) setActivePath(null);
  }

  const empty = repoFiles.length === 0 && files.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-[6px] bg-accent text-[10px] font-bold tracking-tight text-[#0b0c10]">
            HF
          </span>
          <span className="text-[13px] font-medium tracking-tight">Forge</span>
        </div>
        <div className="hidden h-4 w-px bg-line sm:block" />
        <label className="relative hidden sm:block">
          <select
            value={model}
            onChange={(event) => setModel(event.target.value as ModelId)}
            className="appearance-none rounded-md border border-line bg-panel-2 py-1 pr-7 pl-2.5 text-[12px] text-foreground outline-none"
          >
            {MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted">
            <ChevronIcon />
          </span>
        </label>
        <p className="hidden min-w-0 flex-1 truncate text-[12px] text-muted lg:block">
          {modelMeta?.hint}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted md:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Hugging Face
          </span>
          <div className="flex rounded-md border border-line p-0.5 md:hidden">
            {(["files", "chat"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setMobileTab(tab)}
                className={`rounded px-2 py-0.5 text-[11px] capitalize ${
                  mobileTab === tab ? "bg-white/8 text-foreground" : "text-muted"
                }`}
              >
                {tab === "files" ? "Workspace" : "Agent"}
              </button>
            ))}
          </div>
        </div>
      </header>

      {error ? (
        <div className="border-b border-[#f0a0a0]/20 bg-[#f0a0a0]/8 px-3 py-2 text-[12px] text-[#f3c0c0]">
          {error}
        </div>
      ) : null}

      {busy ? <div className="h-px bg-accent" /> : null}

      <div className="grid min-h-0 flex-1 md:grid-cols-[272px_minmax(0,1fr)_400px]">
        <aside
          className={`min-h-0 flex-col border-r border-line bg-panel ${mobileTab === "files" ? "flex" : "hidden"} md:flex`}
        >
          <div className="space-y-2.5 border-b border-line p-3">
            <p className="text-[10px] font-medium tracking-[0.16em] text-muted uppercase">
              Workspace
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                className="rounded-md bg-accent px-2 py-1.5 text-[12px] font-medium text-[#0b0c10]"
              >
                Upload
              </button>
              <button
                type="button"
                onClick={() => folderRef.current?.click()}
                className="rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] text-foreground"
              >
                Folder
              </button>
            </div>
            <input
              ref={uploadRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void onUpload(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={folderRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void onUpload(event.target.files);
                event.target.value = "";
              }}
            />
            <form onSubmit={connectRepo} className="flex gap-1.5">
              <input
                value={repoInput}
                onChange={(event) => setRepoInput(event.target.value)}
                placeholder="owner/repo"
                className="min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2 py-1.5 text-[12px] outline-none placeholder:text-muted/70"
              />
              <button
                type="submit"
                disabled={busy || !repoInput.trim()}
                className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-foreground disabled:opacity-40"
              >
                Clone
              </button>
            </form>
            {repo ? (
              <p className="truncate font-mono text-[11px] text-muted">
                {repo.owner}/{repo.repo}
                <span className="text-muted/60"> @{repo.branch}</span>
              </p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-2">
            {empty ? (
              <p className="px-3 py-8 text-[12px] leading-5 text-muted">
                Drop in a project or clone a public GitHub repository. Checked files are sent to
                the model as context.
              </p>
            ) : (
              <FileNodes
                parent=""
                dirs={dirs}
                files={files}
                repoFiles={repoFiles}
                activePath={activePath}
                selected={selected}
                collapsed={collapsed}
                loadingPath={loadingPath}
                onOpen={(path) => {
                  if (files.some((file) => file.path === path)) setActivePath(path);
                  else void openRepoFile(path);
                }}
                onToggle={toggleSelect}
                onToggleDir={toggleCollapsed}
                onRemove={removeFile}
              />
            )}
          </div>
        </aside>

        <section className="hidden min-h-0 flex-col bg-background md:flex">
          {active ? (
            <>
              <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
                <span className="truncate font-mono text-[12px] text-foreground">{active.path}</span>
                <span className="text-[11px] text-muted">{languageHint(active.path)}</span>
                <span className="text-[11px] text-muted">
                  {active.source === "github" ? "GitHub" : "Local"}
                </span>
                <label className="ml-auto flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={selected.has(active.path)}
                    onChange={() => toggleSelect(active.path)}
                    className="accent-accent"
                  />
                  In context
                </label>
              </div>
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <pre
                  ref={gutterRef}
                  className="editor-gutter m-0 w-12 shrink-0 overflow-hidden border-r border-line bg-panel py-3 pr-2 text-right text-muted/70 select-none"
                >
                  {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                </pre>
                <textarea
                  value={active.content}
                  onChange={(event) => updateActive(event.target.value)}
                  onScroll={(event) => {
                    if (gutterRef.current) {
                      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                    }
                  }}
                  spellCheck={false}
                  className="editor-input min-h-0 flex-1 resize-none overflow-auto bg-background px-4 py-3 text-foreground outline-none"
                />
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center px-10">
              <div className="max-w-lg">
                <p className="text-[13px] font-medium tracking-tight">Open a file to begin</p>
                <p className="mt-2 text-[13px] leading-6 text-muted">
                  Forge is an agent workbench. The editor stays on the left of the conversation,
                  the same way Cursor and Claude Code keep source in view while the model works.
                </p>
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => uploadRef.current?.click()}
                    className="rounded-lg border border-line bg-panel px-3 py-3 text-left"
                  >
                    <p className="text-[12px] font-medium">Upload files</p>
                    <p className="mt-1 text-[11px] leading-4 text-muted">
                      Bring a local module, component, or script.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => document.querySelector<HTMLInputElement>('input[placeholder="owner/repo"]')?.focus()}
                    className="rounded-lg border border-line bg-panel px-3 py-3 text-left"
                  >
                    <p className="text-[12px] font-medium">Connect GitHub</p>
                    <p className="mt-1 text-[11px] leading-4 text-muted">
                      Paste owner/repo. Public trees load instantly.
                    </p>
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <aside
          className={`min-h-0 flex-col border-l border-line bg-panel ${mobileTab === "chat" ? "flex" : "hidden"} md:flex`}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
            <p className="text-[12px] font-medium">Agent</p>
            <p className="text-[11px] text-muted">
              {selected.size + (active ? 1 : 0)} file
              {selected.size + (active ? 1 : 0) === 1 ? "" : "s"} in context
            </p>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
            {messages.length === 0 ? (
              <div className="rounded-lg border border-line bg-panel-2 px-3 py-3 text-[12px] leading-5 text-muted">
                Routed through Hugging Face with your token. Free accounts include about $0.10 of
                inference credits each month. Prefer Flash or Qwen3-Coder-Next if Pro runs hot.
              </div>
            ) : null}
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} onApply={applyProposal} />
            ))}
            {busy ? (
              <p className="text-[11px] tracking-wide text-muted">Generating</p>
            ) : null}
            <div ref={chatEndRef} />
          </div>
          <form
            className="border-t border-line p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="rounded-xl border border-line bg-panel-2 focus-within:border-accent/40">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={3}
                placeholder={
                  active ? `Edit ${active.path.split("/").pop()}…` : "Describe the change…"
                }
                className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[13px] leading-5 outline-none placeholder:text-muted/70"
              />
              <div className="flex items-center justify-between px-2 pb-2">
                <p className="px-1 text-[10px] text-muted">Enter to send · Shift+Enter for newline</p>
                <button
                  type="submit"
                  disabled={busy || !draft.trim()}
                  className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-[#0b0c10] disabled:opacity-35"
                >
                  Send
                </button>
              </div>
            </div>
          </form>
        </aside>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
        <span>{files.length} open</span>
        <span>{repoFiles.length ? `${repoFiles.length} in repo` : "No repo"}</span>
        <span className="ml-auto truncate font-mono">
          {model.split("/")[1] ?? model}
        </span>
      </footer>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 3.5 5 6.5 7.5 3.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function FileNodes({
  parent,
  dirs,
  files,
  repoFiles,
  activePath,
  selected,
  collapsed,
  loadingPath,
  onOpen,
  onToggle,
  onToggleDir,
  onRemove,
}: {
  parent: string;
  dirs: Record<string, string[]>;
  files: WorkspaceFile[];
  repoFiles: string[];
  activePath: string | null;
  selected: Set<string>;
  collapsed: Set<string>;
  loadingPath: string | null;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onToggleDir: (path: string) => void;
  onRemove: (path: string) => void;
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
                className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[12px] text-muted hover:bg-white/4"
              >
                <span className={`inline-block transition ${isCollapsed ? "-rotate-90" : ""}`}>
                  <ChevronIcon />
                </span>
                <span className="truncate">{name}</span>
              </button>
              {isCollapsed ? null : (
                <FileNodes
                  parent={path}
                  dirs={dirs}
                  files={files}
                  repoFiles={repoFiles}
                  activePath={activePath}
                  selected={selected}
                  collapsed={collapsed}
                  loadingPath={loadingPath}
                  onOpen={onOpen}
                  onToggle={onToggle}
                  onToggleDir={onToggleDir}
                  onRemove={onRemove}
                />
              )}
            </li>
          );
        }
        const loaded = files.some((file) => file.path === path);
        const listed = loaded || repoFiles.includes(path);
        if (!listed) return null;
        const active = activePath === path;
        return (
          <li key={path} className="group flex items-center gap-1 pr-1">
            <input
              type="checkbox"
              disabled={!loaded}
              checked={selected.has(path)}
              onChange={() => onToggle(path)}
              className="ml-1 accent-accent"
            />
            <button
              type="button"
              onClick={() => onOpen(path)}
              className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[12px] ${
                active ? "bg-accent-dim text-accent" : "text-foreground/90 hover:bg-white/4"
              }`}
            >
              {loadingPath === path ? "Loading…" : name}
            </button>
            {loaded ? (
              <button
                type="button"
                onClick={() => onRemove(path)}
                className="hidden px-1 text-[11px] text-muted group-hover:block"
              >
                ×
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function MessageBubble({
  message,
  onApply,
}: {
  message: ChatMessage;
  onApply: (path: string, content: string) => void;
}) {
  const proposals = message.role === "assistant" ? parseProposedFiles(message.content) : [];
  const display = message.content.replace(/<file\s+path="[^"]+">[\s\S]*?<\/file>/g, (block) => {
    const path = block.match(/path="([^"]+)"/)?.[1] ?? "file";
    return `\nProposed file: ${path}\n`;
  });

  if (message.role === "user") {
    return (
      <article className="ml-8 rounded-lg bg-white/6 px-3 py-2 text-[13px] leading-6 text-foreground">
        <p className="whitespace-pre-wrap">{message.content}</p>
      </article>
    );
  }

  return (
    <article className="text-[13px] leading-6 text-foreground/90">
      <p className="mb-1 text-[10px] tracking-[0.14em] text-muted uppercase">Agent</p>
      <pre className="whitespace-pre-wrap font-sans">{display || "…"}</pre>
      {proposals.length ? (
        <div className="mt-2 space-y-1">
          {proposals.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => onApply(item.path, item.content)}
              className="block rounded-md border border-accent/25 bg-accent-dim px-2 py-1 text-left font-mono text-[11px] text-accent"
            >
              Apply {item.path}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
