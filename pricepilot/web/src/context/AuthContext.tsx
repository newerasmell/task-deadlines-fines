import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";

interface AuthContextValue {
  authenticated: boolean;
  loading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ authenticated: boolean }>("/auth/me")
      .then((r) => setAuthenticated(r.authenticated))
      .catch(() => setAuthenticated(false))
      .finally(() => setLoading(false));
  }, []);

  async function login(password: string) {
    await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    setAuthenticated(true);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setAuthenticated(false);
  }

  return <AuthContext.Provider value={{ authenticated, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
