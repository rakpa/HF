export const GH_COOKIE = "hf_gh_token";

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function tokenFromRequest(req: Request): string | null {
  const fromCookie = parseCookie(req.headers.get("cookie"), GH_COOKIE);
  if (fromCookie) return fromCookie;
  const fromHeader = req.headers.get("x-github-token");
  if (fromHeader) return fromHeader;
  return process.env.GITHUB_TOKEN || null;
}

export function githubHeaders(token?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "hf-forge",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function tokenCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function clearTokenCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function githubJson<T>(url: string, token: string | null, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 400) || `GitHub ${res.status}` };
  }
  return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
}
