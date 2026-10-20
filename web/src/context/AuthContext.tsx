import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, getToken, setToken } from "../api/client";
import type { Role } from "../api/types";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isSuperAdmin: boolean;
  canAssignTasks: boolean;
  canAccessSubscriptions: boolean;
  telegramChatId: string | null;
  slackMemberId: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  // Re-fetches /auth/me and swaps it into context — used by Profile.tsx to
  // pick up telegramChatId/slackMemberId right after linking, without a
  // full page reload.
  refreshUser: () => Promise<void>;
  // Same effect as login()'s success branch, but for a token/user pair
  // already obtained some other way (e.g. POST /auth/accept-invite) —
  // AcceptInvite.tsx uses this to log a new employee straight in right
  // after they set their own password, with no extra round trip.
  setSession: (token: string, user: AuthUser) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api<AuthUser>("/auth/me")
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const result = await api<{ token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(result.token);
    setUser(result.user);
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  async function refreshUser() {
    if (!getToken()) return;
    setUser(await api<AuthUser>("/auth/me"));
  }

  function setSession(token: string, user: AuthUser) {
    setToken(token);
    setUser(user);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser, setSession }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
