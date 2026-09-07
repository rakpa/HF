"use client";

import Editor, { DiffEditor } from "@monaco-editor/react";

const LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  sql: "sql",
};

export function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE[ext] ?? "plaintext";
}

const options = {
  minimap: { enabled: false },
  fontSize: 13,
  fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 12 },
  renderLineHighlight: "line" as const,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
};

export function CodeEditor({
  path,
  value,
  onChange,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Editor
      theme="vs"
      language={languageOf(path)}
      value={value}
      onChange={(next) => onChange(next ?? "")}
      options={options}
    />
  );
}

export function CodeDiff({
  path,
  original,
  modified,
}: {
  path: string;
  original: string;
  modified: string;
}) {
  return (
    <DiffEditor
      theme="vs"
      language={languageOf(path)}
      original={original}
      modified={modified}
      options={{ ...options, readOnly: true, renderSideBySide: true }}
    />
  );
}
