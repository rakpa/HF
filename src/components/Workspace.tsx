"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  type ProposedFile,
  type WorkspaceFile,
  isSkippedPath,
  parseAgentRuns,
  parseProposedFiles,
} from "@/lib/files";
import { DEFAULT_MODEL, MODELS, type ModelId } from "@/lib/models";

const CodeEditor = dynamic(() => import("./CodeEditor").then((m) => m.CodeEditor), { ssr: false });
const CodeDiff = dynamic(() => import("./CodeEditor").then((m) => m.CodeDiff), { ssr: false });

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };
type GithubRepo = { owner: string; repo: string; branch: string };
type GhUser = { login: string };
type GhRepo = { fullName: string };
type PendingDiff = ProposedFile & { original: string };
type TermLine = { id: string; cmd: string; output: string; running: boolean };

function uid(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function visibleAgentText(content: string, streaming: boolean): string {
  let text = content.replace(
    /<file[\s\S]*?<\/file>|<run\b[\s\S]*?\/>|<run\b[\s\S]*?<\/run>|<command>[\s\S]*?<\/command>/g,
    "",
  );
  if (streaming) {
    text = text.replace(/<file\b[\s\S]*$|<run\b[\s\S]*$|<command>[\s\S]*$/g, "");
  }
  return text.trim();
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
  const [deleted, setDeleted] = useState<string[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [pending, setPending] = useState<PendingDiff[]>([]);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [model, setModel] = useState<ModelId>(DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState("");
  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [ghUser, setGhUser] = useState<GhUser | null>(null);
  const [ghRepos, setGhRepos] = useState<GhRepo[]>([]);
  const [oauth, setOauth] = useState(false);
  const [pat, setPat] = useState("");
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [term, setTerm] = useState<TermLine[]>([]);
  const [newPath, setNewPath] = useState("");
  const [gitOpen, setGitOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const dirty = files.filter((file) => originals[file.path] !== file.content);
  const dirs = useMemo(
    () => treeFromFiles([...new Set([...files.map((f) => f.path), ...repoFiles])]),
    [files, repoFiles],
  );
  const active = files.find((file) => file.path === activePath) ?? null;
  const review = pending[reviewIndex] ?? null;

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
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

  async function loadBranches(target: GithubRepo) {
    const res = await fetch(`/api/github/branches?owner=${target.owner}&repo=${target.repo}`);
    const data = await res.json();
    if (res.ok) setBranches(data.branches ?? []);
  }

  function upsertFile(next: WorkspaceFile, open = true) {
    setFiles((prev) => {
      const rest = prev.filter((file) => file.path !== next.path);
      return [...rest, next].sort((a, b) => a.path.localeCompare(b.path));
    });
    setOriginals((prev) => (next.path in prev ? prev : { ...prev, [next.path]: next.content }));
    if (open) {
      setActivePath(next.path);
      setTabs((prev) => (prev.includes(next.path) ? prev : [...prev, next.path]));
    }
  }

  async function onUpload(list: FileList | null) {
    if (!list?.length) return;
    for (const file of Array.from(list).slice(0, MAX_FILES)) {
      const path = (file.webkitRelativePath || file.name).replace(/^\.\//, "");
      if (isSkippedPath(path) || file.size > MAX_FILE_BYTES) continue;
      upsertFile({ path, content: await file.text(), source: "upload" });
    }
  }

  async function openRepo(input: string, branch?: string) {
    setError(null);
    setBusy(true);
    setStatus("Cloning repository…");
    try {
      const res = await fetch("/api/github/tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: input, branch }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open repo.");
      const nextRepo = {
        owner: data.owner as string,
        repo: data.repo as string,
        branch: branch || (data.branch as string),
      };
      setRepo(nextRepo);
      setRepoFiles(data.files as string[]);
      setFiles([]);
      setOriginals({});
      setDeleted([]);
      setTabs([]);
      setActivePath(null);
      setPending([]);
      await loadBranches(nextRepo);
      const preferred = (data.files as string[])
        .filter((path) => /\.(ts|tsx|js|jsx|py|md|json)$/i.test(path))
        .slice(0, 12);
      setStatus("Reading files…");
      for (const path of preferred) {
        await loadRepoFile(nextRepo, path, preferred[0] === path);
      }
      setStatus("Ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open repo.");
      setStatus("Ready");
    } finally {
      setBusy(false);
    }
  }

  async function loadRepoFile(target: GithubRepo, path: string, open = true) {
    setStatus(`Opening ${path}`);
    const res = await fetch("/api/github/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, path }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load file.");
    upsertFile({ path, content: data.content, source: "github" }, open);
    setOriginals((prev) => ({ ...prev, [path]: data.content }));
    setStatus("Ready");
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const nextMessages = [...messages, { id: uid(), role: "user" as const, content: text }];
    setMessages(nextMessages);
    setDraft("");
    setBusy(true);
    setStatus("Agent is working…");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = uid();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          files,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Chat failed." }));
        throw new Error(data.error || "Chat failed.");
      }
      if (!res.body) throw new Error("No stream.");
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
            // ignore
          }
        }
      }

      const proposed = parseProposedFiles(assembled);
      const runs = parseAgentRuns(assembled);
      if (proposed.length) {
        setStatus("Preparing diffs…");
        const diffs: PendingDiff[] = proposed.map((item) => ({
          ...item,
          original: item.action === "create" ? "" : (files.find((f) => f.path === item.path)?.content ?? originals[item.path] ?? ""),
        }));
        setPending(diffs);
        setReviewIndex(0);
        setShowDiff(true);
        setActivePath(diffs[0].path);
        setCommitMessage(text.slice(0, 72));
      }
      for (const run of runs) {
        queueCommand(run.cmd);
        setTerminalOpen(true);
      }
      setStatus(proposed.length ? "Review diffs" : "Ready");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setStatus("Stopped");
      } else {
        const message = err instanceof Error ? err.message : "Chat failed.";
        setError(message);
        setStatus("Ready");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function queueCommand(cmd: string) {
    const id = uid();
    setTerm((prev) => [
      ...prev,
      {
        id,
        cmd,
        running: false,
        output:
          "This hosted agent cannot execute your repo shell (tests/builds) on Vercel.\nGit commit, branch, push, pull, and pull requests run through the GitHub API.",
      },
    ]);
  }

  function applyReview(item: PendingDiff) {
    if (item.action === "delete") {
      setFiles((prev) => prev.filter((file) => file.path !== item.path));
      setTabs((prev) => prev.filter((path) => path !== item.path));
      setDeleted((prev) => (prev.includes(item.path) ? prev : [...prev, item.path]));
      if (activePath === item.path) setActivePath(null);
    } else {
      upsertFile(
        {
          path: item.path,
          content: item.content,
          source: files.find((file) => file.path === item.path)?.source ?? (repo ? "github" : "upload"),
        },
        true,
      );
      if (item.action === "create") {
        setOriginals((prev) => ({ ...prev, [item.path]: "" }));
      }
      setDeleted((prev) => prev.filter((path) => path !== item.path));
    }
    setPending((prev) => {
      const next = prev.filter((diff) => diff.path !== item.path);
      setReviewIndex(0);
      if (next.length === 0) {
        setShowDiff(false);
        setStatus("Ready");
      }
      return next;
    });
  }

  function applyAllReviews() {
    const items = [...pending];
    for (const item of items) {
      if (item.action === "delete") {
        setFiles((prev) => prev.filter((file) => file.path !== item.path));
        setTabs((prev) => prev.filter((path) => path !== item.path));
        setDeleted((prev) => (prev.includes(item.path) ? prev : [...prev, item.path]));
      } else {
        upsertFile(
          {
            path: item.path,
            content: item.content,
            source: files.find((file) => file.path === item.path)?.source ?? (repo ? "github" : "upload"),
          },
          true,
        );
        if (item.action === "create") {
          setOriginals((prev) => ({ ...prev, [item.path]: "" }));
        }
      }
    }
    setPending([]);
    setShowDiff(false);
    setStatus("Ready");
  }

  function rejectReview(item: PendingDiff) {
    setPending((prev) => {
      const next = prev.filter((diff) => diff.path !== item.path);
      setReviewIndex(0);
      if (next.length === 0) setShowDiff(false);
      return next;
    });
  }

  function createLocalFile(event: React.FormEvent) {
    event.preventDefault();
    const path = newPath.trim().replace(/^\.\//, "");
    if (!path || path.includes("..")) return;
    upsertFile({ path, content: "", source: repo ? "github" : "upload" });
    setOriginals((prev) => ({ ...prev, [path]: "" }));
    setNewPath("");
    setShowDiff(false);
  }

  async function commitToGithub() {
    if (!repo) return;
    const payload = [
      ...dirty.map((file) => ({ path: file.path, content: file.content })),
      ...deleted.map((path) => ({ path, delete: true as const })),
    ];
    if (!payload.length) return;
    setStatus("Committing and pushing…");
    const res = await fetch("/api/github/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...repo, message: commitMessage || "Update from Forge", files: payload }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Commit failed.");
      setStatus("Ready");
      return;
    }
    setOriginals((prev) => {
      const next = { ...prev };
      for (const file of dirty) next[file.path] = file.content;
      for (const path of deleted) delete next[path];
      return next;
    });
    setDeleted([]);
    setNotice(`Pushed ${data.sha?.slice(0, 7)}`);
    setStatus("Ready");
  }

  async function pullRepo() {
    if (!repo) return;
    setStatus("Pulling…");
    try {
      await openRepo(`${repo.owner}/${repo.repo}`, repo.branch);
      setNotice("Pulled latest from GitHub.");
    } finally {
      setStatus("Ready");
    }
  }

  async function createBranch(event: React.FormEvent) {
    event.preventDefault();
    if (!repo || !branchName.trim()) return;
    const res = await fetch("/api/github/branches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...repo, from: repo.branch, name: branchName.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not create branch.");
      return;
    }
    setBranchName("");
    await openRepo(`${repo.owner}/${repo.repo}`, data.name);
    setNotice(`Switched to ${data.name}`);
  }

  async function createPr() {
    if (!repo) return;
    const res = await fetch("/api/github/pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: repo.owner,
        repo: repo.repo,
        head: repo.branch,
        base: branches.includes("main") ? "main" : branches[0],
        title: prTitle || `Changes on ${repo.branch}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not open PR.");
      return;
    }
    setNotice(`Opened PR #${data.number}`);
    window.open(data.url, "_blank");
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
      setError(data.error);
      return;
    }
    setPat("");
    await refreshGithub();
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {busy ? <div className="agent-scan" /> : <div className="h-0.5 bg-line" />}

      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-sidebar px-3 text-[12px]">
        <span className="font-semibold tracking-tight">Forge</span>
        <span className="text-line">/</span>
        <span className="truncate text-muted">
          {repo ? `${repo.owner}/${repo.repo}` : "No repository"}
        </span>
        {activePath ? (
          <>
            <span className="text-line">—</span>
            <span className="truncate font-mono text-[11px]">{activePath}</span>
          </>
        ) : null}
        {busy ? (
          <span className="ml-auto flex items-center gap-2 text-accent">
            <span className="agent-pulse h-1.5 w-1.5 rounded-full bg-accent" />
            {status}
          </span>
        ) : (
          <span className="ml-auto text-muted">{status}</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[252px] shrink-0 flex-col border-r border-line bg-sidebar">
          <div className="flex h-10 items-center justify-between px-3">
            <span className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Explorer</span>
            <button type="button" className="text-[11px] text-accent" onClick={() => uploadRef.current?.click()}>
              Upload
            </button>
          </div>
          <div className="space-y-2 border-b border-line px-2 pb-3">
            {ghUser ? (
              <div className="flex items-center justify-between px-1 text-[12px]">
                <span>@{ghUser.login}</span>
                <button
                  type="button"
                  className="text-muted"
                  onClick={() => void fetch("/api/github/session", { method: "DELETE" }).then(refreshGithub)}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {oauth ? (
                  <a href="/api/github/login" className="block rounded-md bg-accent py-1.5 text-center text-[12px] text-white">
                    Connect GitHub
                  </a>
                ) : null}
                <form onSubmit={savePat}>
                  <input
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    placeholder="GitHub token"
                    type="password"
                    className="mb-1 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
                  />
                  <button type="submit" className="w-full rounded-md border border-line bg-white py-1.5 text-[12px]">
                    Connect GitHub
                  </button>
                </form>
              </div>
            )}
            {ghRepos.length ? (
              <select
                value={repo ? `${repo.owner}/${repo.repo}` : ""}
                onChange={(e) => e.target.value && void openRepo(e.target.value)}
                className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
              >
                <option value="">Select repository</option>
                {ghRepos.map((item) => (
                  <option key={item.fullName} value={item.fullName}>
                    {item.fullName}
                  </option>
                ))}
              </select>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (repoInput.trim()) void openRepo(repoInput);
                }}
                className="flex gap-1"
              >
                <input
                  value={repoInput}
                  onChange={(e) => setRepoInput(e.target.value)}
                  placeholder="owner/repo"
                  className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
                />
                <button className="rounded-md border border-line bg-white px-2 text-[12px]">Open</button>
              </form>
            )}
            <input ref={uploadRef} type="file" multiple className="hidden" onChange={(e) => void onUpload(e.target.files)} />
            <input ref={folderRef} type="file" multiple className="hidden" onChange={(e) => void onUpload(e.target.files)} />
            <button type="button" className="w-full text-left text-[12px] text-muted" onClick={() => folderRef.current?.click()}>
              Add folder
            </button>
            <form onSubmit={createLocalFile} className="flex gap-1">
              <input
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="src/new-file.ts"
                className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
              />
              <button className="rounded-md border border-line bg-white px-2 text-[12px]">New</button>
            </form>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {repoFiles.length === 0 && files.length === 0 ? (
              <p className="px-3 py-4 text-[12px] leading-5 text-muted">Connect GitHub and select a repository to browse files.</p>
            ) : (
              <FileNodes
                parent=""
                dirs={dirs}
                files={files}
                repoFiles={repoFiles}
                activePath={activePath}
                collapsed={collapsed}
                dirty={new Set([...dirty.map((f) => f.path), ...deleted])}
                onOpen={(path) => {
                  if (files.some((file) => file.path === path)) {
                    setActivePath(path);
                    setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
                    setShowDiff(false);
                  } else if (repo) {
                    void loadRepoFile(repo, path, true).catch((err) => {
                      setError(err instanceof Error ? err.message : "Could not load file.");
                      setStatus("Ready");
                    });
                  }
                }}
                onToggleDir={(path) =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              />
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 items-end gap-px overflow-x-auto border-b border-line bg-sidebar">
            {tabs.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => {
                  setActivePath(path);
                  setShowDiff(false);
                }}
                className={`flex h-9 items-center gap-2 border-r border-line px-3 text-[12px] ${
                  activePath === path && !showDiff ? "bg-background" : "text-muted"
                }`}
              >
                {path.split("/").pop()}
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    setTabs((prev) => prev.filter((item) => item !== path));
                    if (activePath === path) setActivePath(tabs.find((item) => item !== path) ?? null);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
            {pending.length ? (
              <button
                type="button"
                onClick={() => setShowDiff(true)}
                className={`h-9 px-3 text-[12px] ${showDiff ? "bg-accent-dim text-accent" : "text-muted"}`}
              >
                Diffs ({pending.length})
              </button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1">
            {showDiff && review ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[12px]">
                  <span className="font-mono">{review.path}</span>
                  <span className="text-muted">{review.action}</span>
                  <span className="text-muted">
                    {reviewIndex + 1}/{pending.length}
                  </span>
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-1 disabled:opacity-40"
                    disabled={reviewIndex <= 0}
                    onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-1 disabled:opacity-40"
                    disabled={reviewIndex >= pending.length - 1}
                    onClick={() => setReviewIndex((i) => Math.min(pending.length - 1, i + 1))}
                  >
                    Next
                  </button>
                  <button type="button" className="ml-auto rounded-md border border-line px-2 py-1" onClick={() => rejectReview(review)}>
                    Reject
                  </button>
                  <button type="button" className="rounded-md bg-accent px-2 py-1 text-white" onClick={() => applyReview(review)}>
                    Apply
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-1"
                    onClick={applyAllReviews}
                  >
                    Apply all
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <CodeDiff path={review.path} original={review.original} modified={review.action === "delete" ? "" : review.content} />
                </div>
              </div>
            ) : active ? (
              <CodeEditor
                path={active.path}
                value={active.content}
                onChange={(value) =>
                  setFiles((prev) => prev.map((file) => (file.path === active.path ? { ...file, content: value } : file)))
                }
              />
            ) : (
              <div className="grid h-full place-items-center text-[13px] text-muted">
                Open a file from the explorer
              </div>
            )}
          </div>

          {terminalOpen ? (
            <div className="flex h-36 shrink-0 flex-col border-t border-line bg-[#fafafa]">
              <div className="flex h-7 items-center justify-between border-b border-line px-3 text-[11px] text-muted">
                <span>Terminal</span>
                <button type="button" onClick={() => setTerminalOpen(false)}>
                  Hide
                </button>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-[#333]">
                {term.length === 0
                  ? "Agent run commands will appear here."
                  : term.map((line) => `$ ${line.cmd}\n${line.output}\n`).join("\n")}
              </pre>
            </div>
          ) : null}
        </section>

        <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel">
          <div className="flex h-10 items-center gap-2 border-b border-line px-3">
            <div className="flex items-center gap-2 text-[12px] font-medium">
              {busy ? <span className="agent-pulse h-2 w-2 rounded-full bg-accent" /> : <span className="h-2 w-2 rounded-full bg-[#c8c8c8]" />}
              Agent
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelId)}
              className="ml-auto max-w-[160px] truncate rounded-md border border-line bg-white px-1.5 py-0.5 text-[11px] outline-none"
            >
              {MODELS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            {busy ? (
              <button type="button" className="text-[11px] text-muted" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : null}
          </div>
          {busy ? (
            <div className="flex items-center gap-2 border-b border-line bg-accent-dim px-3 py-1.5 text-[11px] text-accent">
              <span className="agent-pulse h-1.5 w-1.5 rounded-full bg-accent" />
              Working — {status}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
            {messages.length === 0 ? (
              <p className="text-[13px] leading-6 text-muted">
                Ask the agent to read, edit, create, or delete files. It will show a live diff before applying. Then commit, push, or open a PR.
              </p>
            ) : (
              messages.map((message) => {
                const visible = visibleAgentText(message.content, busy && message.role === "assistant");
                return (
                  <article key={message.id} className="mb-5">
                    <p className="mb-1 text-[11px] font-medium text-muted">{message.role === "user" ? "You" : "Agent"}</p>
                    <pre className="whitespace-pre-wrap font-sans text-[13px] leading-6">
                      {visible || (busy && message.role === "assistant" ? "" : "…")}
                    </pre>
                  </article>
                );
              })
            )}
            {busy ? (
              <p className="flex items-center gap-2 text-[12px] text-accent">
                <span className="agent-pulse h-1.5 w-1.5 rounded-full bg-accent" />
                Generating…
              </p>
            ) : null}
            <div ref={chatEndRef} />
          </div>
          <form
            className="border-t border-line p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Edit the repo, run tests, open a PR…"
              className="w-full resize-none rounded-md border border-line bg-white px-3 py-2 text-[13px] outline-none"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="mt-2 w-full rounded-md bg-accent py-1.5 text-[12px] text-white disabled:opacity-40"
            >
              {busy ? "Working…" : "Send"}
            </button>
          </form>
        </aside>
      </div>

      {gitOpen ? (
        <div className="border-t border-line bg-sidebar px-3 py-2">
          <div className="mx-auto flex max-w-5xl flex-wrap items-end gap-2 text-[12px]">
            {repo && branches.length ? (
              <select
                value={repo.branch}
                onChange={(e) => void openRepo(`${repo.owner}/${repo.repo}`, e.target.value)}
                className="rounded-md border border-line bg-white px-2 py-1 outline-none"
              >
                {branches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
            <form onSubmit={createBranch} className="flex gap-1">
              <input
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
                placeholder="new-branch"
                className="rounded-md border border-line bg-white px-2 py-1 outline-none"
              />
              <button className="rounded-md border border-line bg-white px-2 py-1">Branch</button>
            </form>
            <input
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message"
              className="min-w-[180px] flex-1 rounded-md border border-line bg-white px-2 py-1 outline-none"
            />
            <button type="button" className="rounded-md border border-line bg-white px-2 py-1" onClick={() => void commitToGithub()}>
              Commit & push
            </button>
            <button type="button" className="rounded-md border border-line bg-white px-2 py-1" onClick={() => void pullRepo()}>
              Pull
            </button>
            <input
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder="PR title"
              className="rounded-md border border-line bg-white px-2 py-1 outline-none"
            />
            <button type="button" className="rounded-md bg-accent px-2 py-1 text-white" onClick={() => void createPr()}>
              Create PR
            </button>
          </div>
        </div>
      ) : null}

      <footer className="flex h-[22px] items-center gap-3 border-t border-line bg-status px-3 text-[11px] text-status-fg">
        <button type="button" onClick={() => setGitOpen((v) => !v)}>
          {repo ? `⎇ ${repo.branch}` : "No repo"}
        </button>
        <span className={`truncate ${busy ? "text-accent" : ""}`}>{busy ? status : error || notice || status}</span>
        <span className="ml-auto">{MODELS.find((item) => item.id === model)?.label}</span>
        <button type="button" onClick={() => setTerminalOpen((v) => !v)}>
          Terminal
        </button>
        <span>
          {dirty.length + deleted.length} change{dirty.length + deleted.length === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
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
  onOpen: (path: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const names = dirs[parent] ?? [];
  return (
    <ul className={parent ? "ml-3" : "px-1"}>
      {names.map((name) => {
        const path = joinPath(parent, name);
        if (dirs[path]) {
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => onToggleDir(path)}
                className="flex w-full rounded px-1.5 py-0.5 text-left text-[12px] text-[#444] hover:bg-white"
              >
                {collapsed.has(path) ? "▸ " : "▾ "}
                {name}
              </button>
              {collapsed.has(path) ? null : (
                <FileNodes
                  parent={path}
                  dirs={dirs}
                  files={files}
                  repoFiles={repoFiles}
                  activePath={activePath}
                  collapsed={collapsed}
                  dirty={dirty}
                  onOpen={onOpen}
                  onToggleDir={onToggleDir}
                />
              )}
            </li>
          );
        }
        if (!files.some((file) => file.path === path) && !repoFiles.includes(path)) return null;
        return (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              className={`flex w-full items-center justify-between rounded px-1.5 py-0.5 text-left text-[12px] ${
                activePath === path ? "bg-accent-dim text-accent" : "hover:bg-white"
              }`}
            >
              <span className="truncate">{name}</span>
              {dirty.has(path) ? <span className="text-accent">M</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
