import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { CurrentUser } from "../api/types";

interface AuthContextValue {
  user: CurrentUser | null;
  authenticated: boolean;
  loading: boolean;
  // Only meaningful while `user` is null: true means no account exists yet
  // and Login should show the "create the first admin" form instead of an
  // email/password login form.
  needsSetup: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string, dashboardPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ authenticated: boolean; user: CurrentUser | null }>("/auth/me")
      .then(async (r) => {
        setUser(r.user);
        if (!r.user) {
          const setupCheck = await api<{ needsSetup: boolean }>("/auth/needs-setup");
          setNeedsSetup(setupCheck.needsSetup);
        }
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const u = await api<CurrentUser>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setUser(u);
  }

  async function setup(name: string, email: string, password: string, dashboardPassword: string) {
    const u = await api<CurrentUser>("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ name, email, password, dashboardPassword }),
    });
    setUser(u);
    setNeedsSetup(false);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, authenticated: Boolean(user), loading, needsSetup, login, setup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
