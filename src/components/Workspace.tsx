"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  type ProposedFile,
  type WorkspaceFile,
  isSkippedPath,
  parseAgentRuns,
  parseProposedFiles,
} from "@/lib/files";
import { DEFAULT_MODEL, MODELS, isAllowedModel, type ModelId } from "@/lib/models";

const CodeEditor = dynamic(() => import("./CodeEditor").then((m) => m.CodeEditor), { ssr: false });
const CodeDiff = dynamic(() => import("./CodeEditor").then((m) => m.CodeDiff), { ssr: false });

const MODEL_KEY = "forge-model";

type ChatMessage = { id: string; role: "user" | "assistant"; content: string; model?: string };
type GithubRepo = { owner: string; repo: string; branch: string };
type GhUser = { login: string };
type GhRepo = { fullName: string };
type PendingDiff = ProposedFile & { original: string };

function uid(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function visibleAgentText(content: string, streaming: boolean): string {
  let text = content.replace(
    /<file[\s\S]*?<\/file>|<run\b[\s\S]*?\/>|<run\b[\s\S]*?<\/run>|<command>[\s\S]*?<\/command>/g,
    (block) => {
      const path = block.match(/path="([^"]+)"/)?.[1];
      const cmd = block.match(/cmd="([^"]+)"/)?.[1] || (block.match(/<(?:run|command)>([\s\S]*?)<\//)?.[1] ?? "").trim();
      if (path) return `\nProposed ${path}\n`;
      if (cmd) return `\nRun: ${cmd}\n`;
      return "";
    },
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
  const [activePath, setActivePath] = useState<string | null>(null);
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
  const [connecting, setConnecting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<ModelId>(model);
  const filesRef = useRef<WorkspaceFile[]>(files);

  modelRef.current = model;
  filesRef.current = files;

  function closeSidebar() {
    setSidebarOpen(false);
  }

  const dirty = files.filter((file) => originals[file.path] !== file.content);
  const dirs = useMemo(
    () => treeFromFiles([...new Set([...files.map((file) => file.path), ...repoFiles])]),
    [files, repoFiles],
  );
  const active = files.find((file) => file.path === activePath) ?? null;
  const review = pending[reviewIndex] ?? null;
  const emptyChat = messages.length === 0;
  const selectedModel = MODELS.find((item) => item.id === model) ?? MODELS[0];

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    const saved = window.localStorage.getItem(MODEL_KEY);
    if (saved && isAllowedModel(saved)) setModel(saved);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(MODEL_KEY, model);
  }, [model]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("github");
    if (flag === "connected") setNotice("GitHub connected.");
    if (flag === "denied") setError("GitHub access was denied.");
    if (flag === "token_failed" || flag === "missing_oauth") {
      setError("GitHub OAuth is not set up. Paste a personal access token instead.");
    }
    void refreshGithub();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mq.matches) setSidebarOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [sidebarOpen]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  async function refreshGithub() {
    const res = await fetch("/api/github/status");
    const data = await res.json();
    setOauth(Boolean(data.oauth));
    if (data.connected && data.user) {
      setGhUser(data.user);
      const list = await fetch("/api/github/repos");
      const payload = await list.json();
      if (list.ok) setGhRepos(payload.repos ?? []);
      else setError(payload.error || "Connected, but could not list repositories.");
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

  function upsertFile(next: WorkspaceFile, open = false) {
    setFiles((prev) => {
      const rest = prev.filter((file) => file.path !== next.path);
      return [...rest, next].sort((a, b) => a.path.localeCompare(b.path));
    });
    setOriginals((prev) => (next.path in prev ? prev : { ...prev, [next.path]: next.content }));
    if (open) setActivePath(next.path);
  }

  async function onUpload(list: FileList | null) {
    if (!list?.length) return;
    const added: WorkspaceFile[] = [];
    let skipped = 0;
    for (const file of Array.from(list).slice(0, MAX_FILES)) {
      const path = (file.webkitRelativePath || file.name).replace(/^\.\//, "");
      if (isSkippedPath(path) || file.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      added.push({ path, content: await file.text(), source: "upload" });
    }
    if (uploadRef.current) uploadRef.current.value = "";
    if (folderRef.current) folderRef.current.value = "";
    if (!added.length) {
      setError("No text files added. Binaries, node_modules, and files over 200 KB are skipped.");
      return;
    }
    setFiles((prev) => {
      const map = new Map(prev.map((file) => [file.path, file]));
      for (const file of added) map.set(file.path, file);
      return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
    });
    setOriginals((prev) => {
      const next = { ...prev };
      for (const file of added) {
        if (!(file.path in next)) next[file.path] = file.content;
      }
      return next;
    });
    filesRef.current = (() => {
      const map = new Map(filesRef.current.map((file) => [file.path, file]));
      for (const file of added) map.set(file.path, file);
      return [...map.values()];
    })();
    setActivePath(null);
    setError(null);
    setNotice(
      `${added.length} file${added.length === 1 ? "" : "s"} in the workspace. Ask the agent to read or edit them.${
        skipped ? ` Skipped ${skipped}.` : ""
      }`,
    );
  }

  async function openRepo(input: string, branch?: string) {
    setError(null);
    setBusy(true);
    setStatus("Opening repository…");
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
      setActivePath(null);
      setPending([]);
      filesRef.current = [];
      await loadBranches(nextRepo);
      const preferred = (data.files as string[])
        .filter((path) => /\.(ts|tsx|js|jsx|py|md|json)$/i.test(path))
        .slice(0, 20);
      setStatus("Reading files into workspace…");
      const loaded: WorkspaceFile[] = [];
      for (const path of preferred) {
        const file = await fetchRepoFile(nextRepo, path);
        if (file) loaded.push(file);
      }
      setFiles(loaded);
      setOriginals(Object.fromEntries(loaded.map((file) => [file.path, file.content])));
      filesRef.current = loaded;
      setNotice(`${loaded.length} files loaded from ${nextRepo.owner}/${nextRepo.repo}. The agent can read and edit them.`);
      setStatus("Ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open repo.");
      setStatus("Ready");
    } finally {
      setBusy(false);
    }
  }

  async function fetchRepoFile(target: GithubRepo, path: string): Promise<WorkspaceFile | null> {
    const res = await fetch("/api/github/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, path }),
    });
    const data = await res.json();
    if (!res.ok) return null;
    return { path, content: data.content, source: "github" };
  }

  async function loadRepoFile(target: GithubRepo, path: string, open = false) {
    setStatus(`Opening ${path}`);
    const file = await fetchRepoFile(target, path);
    if (!file) throw new Error(`Could not load ${path}.`);
    upsertFile(file, open);
    filesRef.current = [...filesRef.current.filter((item) => item.path !== path), file];
    setOriginals((prev) => ({ ...prev, [path]: file.content }));
    setStatus("Ready");
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    const workspace = filesRef.current;
    const selected = modelRef.current;
    const nextMessages = [...messages, { id: uid(), role: "user" as const, content: text }];
    setMessages(nextMessages);
    setDraft("");
    setBusy(true);
    setStatus(`Working with ${MODELS.find((item) => item.id === selected)?.label ?? selected}…`);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = uid();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", model: selected }]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selected,
          messages: nextMessages.map(({ role, content }) => ({ role, content })),
          files: workspace,
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
            // ignore incomplete SSE chunks
          }
        }
      }

      const proposed = parseProposedFiles(assembled);
      const runs = parseAgentRuns(assembled);
      if (proposed.length) {
        const diffs: PendingDiff[] = proposed.map((item) => ({
          ...item,
          original:
            item.action === "create"
              ? ""
              : (workspace.find((file) => file.path === item.path)?.content ?? originals[item.path] ?? ""),
        }));
        setPending(diffs);
        setReviewIndex(0);
        setCommitMessage(text.slice(0, 72));
      }
      if (runs.length) {
        setNotice(`Agent asked to run: ${runs.map((run) => run.cmd).join(", ")}. Hosted Vercel cannot execute your repo shell.`);
      }
      setStatus(proposed.length ? "Review diffs" : "Ready");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setStatus("Stopped");
      } else {
        setError(err instanceof Error ? err.message : "Chat failed.");
        setStatus("Ready");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function applyReview(item: PendingDiff) {
    if (item.action === "delete") {
      setFiles((prev) => prev.filter((file) => file.path !== item.path));
      filesRef.current = filesRef.current.filter((file) => file.path !== item.path);
      setDeleted((prev) => (prev.includes(item.path) ? prev : [...prev, item.path]));
      if (activePath === item.path) setActivePath(null);
    } else {
      const next = {
        path: item.path,
        content: item.content,
        source: files.find((file) => file.path === item.path)?.source ?? (repo ? "github" : "upload"),
      } as WorkspaceFile;
      upsertFile(next, false);
      filesRef.current = [...filesRef.current.filter((file) => file.path !== item.path), next];
      if (item.action === "create") setOriginals((prev) => ({ ...prev, [item.path]: "" }));
      setDeleted((prev) => prev.filter((path) => path !== item.path));
    }
    setPending((prev) => {
      const next = prev.filter((diff) => diff.path !== item.path);
      setReviewIndex(0);
      if (next.length === 0) setStatus("Ready");
      return next;
    });
  }

  function applyAllReviews() {
    for (const item of [...pending]) applyReview(item);
    setPending([]);
    setStatus("Ready");
  }

  function rejectReview(item: PendingDiff) {
    setPending((prev) => {
      const next = prev.filter((diff) => diff.path !== item.path);
      setReviewIndex(0);
      return next;
    });
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
    await openRepo(`${repo.owner}/${repo.repo}`, repo.branch);
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
    const token = pat.trim();
    if (!token) {
      setError("Paste a GitHub personal access token with the repo scope, then click Connect GitHub.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/github/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not connect GitHub.");
        return;
      }
      setPat("");
      setNotice(`Connected as @${data.user?.login ?? "github"}`);
      await refreshGithub();
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-background text-foreground">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close workspace"
          className="fixed inset-0 z-30 bg-black/35 md:hidden"
          onClick={closeSidebar}
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(100vw,20rem)] max-w-full shrink-0 flex-col border-r border-line bg-sidebar transition-transform duration-200 ease-out md:static md:z-auto md:w-[272px] md:translate-x-0 ${
          sidebarOpen ? "translate-x-0 shadow-[8px_0_30px_rgba(0,0,0,0.12)]" : "-translate-x-full md:translate-x-0"
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-3 md:hidden">
          <p className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">Workspace</p>
          <button
            type="button"
            onClick={closeSidebar}
            className="rounded-md border border-line bg-white px-2.5 py-1.5 text-[12px]"
            aria-label="Close workspace panel"
          >
            Close
          </button>
        </div>
        <div className="space-y-2 border-b border-line px-3 py-3">
          <p className="hidden text-[11px] font-semibold tracking-[0.12em] text-muted uppercase md:block">Workspace</p>
          {ghUser ? (
            <div className="flex items-center justify-between text-[12px]">
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
            <div className="space-y-2">
              {oauth ? (
                <a href="/api/github/login" className="block rounded-md bg-accent py-2 text-center text-[12px] text-white">
                  Connect GitHub
                </a>
              ) : null}
              <form onSubmit={savePat} className="space-y-1.5">
                <input
                  value={pat}
                  onChange={(event) => setPat(event.target.value)}
                  placeholder="ghp_ or github_pat_ token"
                  type="password"
                  autoComplete="off"
                  className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
                />
                <button
                  type="submit"
                  disabled={connecting}
                  className={`w-full rounded-md py-2 text-[12px] disabled:opacity-40 ${
                    oauth ? "border border-line bg-white" : "bg-accent text-white"
                  }`}
                >
                  {connecting ? "Connecting…" : oauth ? "Connect with token" : "Connect GitHub"}
                </button>
              </form>
              <p className="text-[11px] leading-4 text-muted">
                Create a token at github.com/settings/tokens with repo access, then paste it here.
              </p>
            </div>
          )}
          {error ? <p className="text-[12px] leading-4 text-[#b42318]">{error}</p> : null}

          {ghRepos.length ? (
            <select
              value={repo ? `${repo.owner}/${repo.repo}` : ""}
              onChange={(event) => {
                if (event.target.value) {
                  void openRepo(event.target.value);
                  closeSidebar();
                }
              }}
              className="w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
            >
              <option value="">Select repository</option>
              {ghRepos.map((item) => (
                <option key={item.fullName} value={item.fullName}>
                  {item.fullName}
                </option>
              ))}
            </select>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (repoInput.trim()) {
                void openRepo(repoInput);
                closeSidebar();
              }
            }}
            className="flex gap-1"
          >
            <input
              value={repoInput}
              onChange={(event) => setRepoInput(event.target.value)}
              placeholder="owner/repo"
              className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-[12px] outline-none"
            />
            <button type="submit" className="rounded-md border border-line bg-white px-2 text-[12px]">
              Open
            </button>
          </form>

          <div className="flex gap-1">
            <button type="button" onClick={() => uploadRef.current?.click()} className="flex-1 rounded-md border border-line bg-white py-1.5 text-[12px]">
              Upload files
            </button>
            <button type="button" onClick={() => folderRef.current?.click()} className="flex-1 rounded-md border border-line bg-white py-1.5 text-[12px]">
              Folder
            </button>
          </div>
          <input ref={uploadRef} type="file" multiple className="hidden" onChange={(event) => void onUpload(event.target.files)} />
          <input ref={folderRef} type="file" multiple className="hidden" onChange={(event) => void onUpload(event.target.files)} />
          <p className="text-[11px] text-muted">
            {files.length} file{files.length === 1 ? "" : "s"} attached to chat
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-2">
          {repo ? (
            <p className="px-3 pb-2 font-mono text-[11px] text-muted">
              {repo.owner}/{repo.repo}@{repo.branch}
            </p>
          ) : null}
          {repoFiles.length === 0 && files.length === 0 ? (
            <p className="px-3 text-[12px] leading-5 text-muted">
              Connect GitHub or upload a folder. Those files become the workspace the agent reads and edits.
            </p>
          ) : (
            <FileNodes
              parent=""
              dirs={dirs}
              files={files}
              repoFiles={repoFiles}
              activePath={activePath}
              collapsed={collapsed}
              dirty={new Set([...dirty.map((file) => file.path), ...deleted])}
              onOpen={(path) => {
                if (files.some((file) => file.path === path)) {
                  setActivePath(path);
                  closeSidebar();
                } else if (repo) {
                  void loadRepoFile(repo, path, true)
                    .then(closeSidebar)
                    .catch((err) => {
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

        {repo ? (
          <div className="space-y-2 border-t border-line p-3 text-[12px]">
            {branches.length ? (
              <select
                value={repo.branch}
                onChange={(event) => void openRepo(`${repo.owner}/${repo.repo}`, event.target.value)}
                className="w-full rounded-md border border-line bg-white px-2 py-1.5 outline-none"
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
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="new-branch"
                className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1.5 outline-none"
              />
              <button className="rounded-md border border-line bg-white px-2">Branch</button>
            </form>
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Commit message"
              className="w-full rounded-md border border-line bg-white px-2 py-1.5 outline-none"
            />
            <button type="button" className="w-full rounded-md border border-line bg-white py-1.5" onClick={() => void commitToGithub()}>
              Commit & push
            </button>
            <button type="button" className="w-full rounded-md border border-line bg-white py-1.5" onClick={() => void pullRepo()}>
              Pull
            </button>
            <input
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
              placeholder="PR title"
              className="w-full rounded-md border border-line bg-white px-2 py-1.5 outline-none"
            />
            <button type="button" className="w-full rounded-md bg-accent py-1.5 text-white" onClick={() => void createPr()}>
              Create PR
            </button>
          </div>
        ) : null}
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        {busy ? <div className="agent-scan" /> : <div className="h-0.5 bg-transparent" />}
        <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:gap-3 sm:px-4">
          <button
            type="button"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-line bg-white md:hidden"
            aria-expanded={sidebarOpen}
            aria-label="Open workspace"
            onClick={() => setSidebarOpen(true)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <span className="shrink-0 font-semibold tracking-tight">Forge</span>
          <label className="ml-0 flex min-w-0 items-center gap-1.5 text-[13px] sm:ml-2 sm:gap-2">
            <span className="hidden text-muted sm:inline">Model</span>
            <select
              value={model}
              onChange={(event) => {
                const next = event.target.value;
                if (isAllowedModel(next)) {
                  setModel(next);
                  modelRef.current = next;
                  setNotice(`Using ${MODELS.find((item) => item.id === next)?.label}`);
                }
              }}
              className="max-w-[42vw] truncate rounded-full border border-line bg-white px-2.5 py-1 outline-none sm:max-w-none sm:px-3"
            >
              {MODELS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {busy ? (
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-accent">
              <span className="agent-pulse h-2 w-2 shrink-0 rounded-full bg-accent" />
              <span className="truncate">{status}</span>
              <button type="button" className="shrink-0 text-muted" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            </span>
          ) : (
            <span className="hidden text-[12px] text-muted lg:inline">{selectedModel.label}</span>
          )}
          <span className="ml-auto hidden max-w-[40%] truncate text-right text-[12px] text-muted sm:inline">
            {repo ? `${repo.owner}/${repo.repo}` : files.length ? `${files.length} uploaded` : "No repo"}
            {dirty.length + deleted.length ? ` · ${dirty.length + deleted.length} changed` : ""}
          </span>
        </header>

        {notice && !error ? <p className="px-4 pb-2 text-center text-[13px] text-accent">{notice}</p> : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {emptyChat ? (
            <div className="flex flex-1 flex-col items-center justify-center px-4 py-6">
              <h1 className="mb-3 max-w-xl text-center text-[22px] font-medium tracking-tight sm:text-[28px]">
                {repo ? `What should we change in ${repo.repo}?` : "What do you want to build?"}
              </h1>
              <p className="mb-8 max-w-md text-center text-[14px] text-muted">
                {files.length
                  ? `${files.length} file${files.length === 1 ? "" : "s"} are attached. Ask to read or edit any of them.`
                  : "Use the workspace panel to upload files or connect GitHub, then chat here."}
              </p>
              <Composer draft={draft} setDraft={setDraft} busy={busy} onSend={() => void send()} composerRef={composerRef} wide />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[48rem] flex-1 px-4 py-6">
              {messages.map((message) => {
                const visible = visibleAgentText(message.content, busy && message.role === "assistant");
                return (
                  <article key={message.id} className="mb-8">
                    <p className="mb-2 text-[12px] font-medium text-muted">
                      {message.role === "user"
                        ? "You"
                        : `Forge · ${MODELS.find((item) => item.id === message.model)?.label ?? selectedModel.label}`}
                    </p>
                    <pre className="whitespace-pre-wrap break-words font-sans text-[16px] leading-7">
                      {visible || (busy && message.role === "assistant" ? "" : "…")}
                    </pre>
                  </article>
                );
              })}
              {busy ? (
                <p className="flex items-center gap-2 text-[13px] text-accent">
                  <span className="agent-pulse h-2 w-2 rounded-full bg-accent" />
                  Working — {status}
                </p>
              ) : null}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>

        {emptyChat ? null : (
          <div className="mx-auto w-full max-w-[48rem] px-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-5">
            {dirty.length + deleted.length && repo ? (
              <div className="mb-3 flex flex-col gap-2 rounded-2xl border border-line bg-panel px-3 py-2 sm:flex-row sm:items-center">
                <input
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder={`Commit ${dirty.length + deleted.length} change${dirty.length + deleted.length === 1 ? "" : "s"} to GitHub`}
                  className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                />
                <button type="button" onClick={() => void commitToGithub()} className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[12px] text-white">
                  Commit & push
                </button>
              </div>
            ) : null}
            <Composer draft={draft} setDraft={setDraft} busy={busy} onSend={() => void send()} composerRef={composerRef} />
          </div>
        )}

        {review ? (
          <div className="absolute inset-0 z-20 flex flex-col bg-background">
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-3 text-[12px] sm:px-4">
              <span className="max-w-full truncate font-mono">{review.path}</span>
              <span className="text-muted">{review.action}</span>
              <span className="text-muted">
                {reviewIndex + 1}/{pending.length}
              </span>
              <button type="button" className="rounded-md border border-line px-2 py-1 disabled:opacity-40" disabled={reviewIndex <= 0} onClick={() => setReviewIndex((i) => Math.max(0, i - 1))}>
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
              <button type="button" className="rounded-md border border-line px-2 py-1 sm:ml-auto" onClick={() => rejectReview(review)}>
                Reject
              </button>
              <button type="button" className="rounded-md bg-accent px-2 py-1 text-white" onClick={() => applyReview(review)}>
                Apply
              </button>
              <button type="button" className="rounded-md border border-line px-2 py-1" onClick={applyAllReviews}>
                Apply all
              </button>
              <button type="button" className="text-muted" onClick={() => setPending([])}>
                Back to chat
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <CodeDiff path={review.path} original={review.original} modified={review.action === "delete" ? "" : review.content} />
            </div>
          </div>
        ) : active ? (
          <div className="absolute inset-0 z-10 flex flex-col bg-background">
            <div className="flex h-14 items-center gap-3 border-b border-line px-4">
              <p className="min-w-0 truncate font-mono text-[13px]">{active.path}</p>
              <button type="button" className="ml-auto shrink-0 text-[13px] text-muted" onClick={() => setActivePath(null)}>
                Back to chat
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <CodeEditor
                path={active.path}
                value={active.content}
                onChange={(value) => {
                  setFiles((prev) => prev.map((file) => (file.path === active.path ? { ...file, content: value } : file)));
                  filesRef.current = filesRef.current.map((file) =>
                    file.path === active.path ? { ...file, content: value } : file,
                  );
                }}
              />
            </div>
          </div>
        ) : null}
      </section>
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
      <div className="rounded-[28px] border border-line bg-white px-4 pt-3 pb-2 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
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
          <p className="text-[11px] text-muted">{busy ? "Working…" : "Enter to send"}</p>
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
    <ul className={parent ? "ml-2" : "px-1"}>
      {names.map((name) => {
        const path = joinPath(parent, name);
        if (dirs[path]) {
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => onToggleDir(path)}
                className="flex w-full rounded-md px-2 py-1 text-left text-[13px] text-[#444] hover:bg-white"
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
              className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[13px] ${
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
