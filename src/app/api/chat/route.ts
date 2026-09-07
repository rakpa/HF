import { NextResponse } from "next/server";
import { buildFileContext, type WorkspaceFile } from "@/lib/files";
import { DEFAULT_MODEL, isAllowedModel } from "@/lib/models";

export const maxDuration = 60;

const SYSTEM = `You are Codeforge, a coding agent running inside a web IDE.
The user may attach uploaded files or a cloned GitHub workspace.
Write and edit real code. Prefer complete, working files over snippets.
When you create or replace a file, emit it in BOTH of these forms so the IDE can apply it:

<file path="relative/path.ext">
full file contents
</file>

Keep paths relative to the workspace root. Do not wrap the <file> tag in a markdown fence.
If you only discuss code, you can still use markdown fences. Be concise unless the user asks for a full implementation.`;

type ChatMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  const token = process.env.HF_TOKEN;
  if (!token) {
    return NextResponse.json(
      {
        error:
          "HF_TOKEN is not set. Add your Hugging Face token in .env.local (local) or Vercel env vars (deploy).",
      },
      { status: 500 },
    );
  }

  let body: {
    messages?: ChatMessage[];
    model?: string;
    files?: WorkspaceFile[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const model = body.model && isAllowedModel(body.model) ? body.model : DEFAULT_MODEL;
  const history = Array.isArray(body.messages) ? body.messages.slice(-24) : [];
  const files = Array.isArray(body.files) ? body.files.slice(0, 40) : [];
  const fileContext = buildFileContext(files);

  const messages = [
    {
      role: "system" as const,
      content: fileContext
        ? `${SYSTEM}\n\nWorkspace files:\n\n${fileContext}`
        : SYSTEM,
    },
    ...history.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 20_000),
    })),
  ];

  const upstream = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    let message = `Hugging Face request failed (${upstream.status}).`;
    if (upstream.status === 401) {
      message = "Hugging Face rejected the token. Create a fine-grained token with Inference Providers permission.";
    } else if (upstream.status === 402) {
      message =
        "Hugging Face free credits for this month are used up ($0.10 on free accounts). Switch to DeepSeek V4 Flash or Qwen3-Coder-Next, wait for the monthly reset, or add HF PRO / extra credits.";
    } else if (detail) {
      message = detail.slice(0, 800);
    }
    return NextResponse.json({ error: message }, { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
