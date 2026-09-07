# HF

A coding agent you deploy on [Vercel](https://vercel.com). Chat with **DeepSeek V4 Pro** through [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers) using `HF_TOKEN`. Upload files or connect a GitHub repo.

The model does not run on Vercel. Vercel hosts the UI; Hugging Face routes your token to a provider that serves DeepSeek.

## Hugging Face token

1. Create a **fine-grained** token at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
2. Enable **Make calls to Inference Providers**.
3. In Vercel → Project → Settings → Environment Variables, add:

```
HF_TOKEN=hf_...
```

Optional: add a GitHub token so the agent can open private repos and **commit & push** like Cursor:

```
GITHUB_TOKEN=ghp_...
```

Use a classic token with the `repo` scope, or GitHub OAuth:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

OAuth callback URL: `https://YOUR_VERCEL_DOMAIN/api/github/callback`

Free Hugging Face accounts get about **$0.10/month** of routed inference credits (PRO: **$2**). If chat returns 402, switch the model to DeepSeek V4 Flash or Qwen3-Coder-Next.

## Deploy on Vercel

Import this GitHub repo in Vercel, set `HF_TOKEN`, deploy. Git commits must use a real address on your GitHub account (not a `.local` machine email), or Vercel will block the deployment.

## What it does

- Stream chat (ChatGPT-style, centered) with DeepSeek V4 Pro
- Connect GitHub (OAuth or a repo-scoped token), pick a repo, and let the agent read it
- Apply edits in the workspace, then **commit & push** back to GitHub
- Upload files or a folder when you are not using git
