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

Optional: `GITHUB_TOKEN` for private repos and a higher GitHub rate limit.

Free Hugging Face accounts get about **$0.10/month** of routed inference credits (PRO: **$2**). If chat returns 402, switch the model to DeepSeek V4 Flash or Qwen3-Coder-Next.

## Deploy on Vercel

Import this GitHub repo in Vercel, set `HF_TOKEN`, deploy. Git commits must use a real address on your GitHub account (not a `.local` machine email), or Vercel will block the deployment.

## What it does

- Stream chat with DeepSeek V4 Pro (or Flash / Qwen3-Coder-Next)
- Upload files or a folder
- Connect `owner/repo` or a GitHub URL
- Include open/checked files as model context
- Apply proposed files into the workspace
