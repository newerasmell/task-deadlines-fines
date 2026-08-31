const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";

let token: string | null = localStorage.getItem("token");

export function setToken(newToken: string | null) {
  token = newToken;
  if (newToken) {
    localStorage.setItem("token", newToken);
  } else {
    localStorage.removeItem("token");
  }
}

export function getToken(): string | null {
  return token;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? JSON.stringify((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }

  return body as T;
}
