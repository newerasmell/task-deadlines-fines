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
  // Only meaningful once logged in: true means accounts exist but none of
  // them is an ultimate admin (e.g. this account predates that role, or
  // the sole admin got removed) — Settings should offer the one-time
  // "claim ultimate admin" prompt (see claimAdmin below).
  needsAdminClaim: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string, dashboardPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  // Self-service only — every account can change their OWN name/password
  // this way. Managing anyone else's account is Settings -> Team, visible
  // only to ultimate admins.
  updateProfile: (fields: { name?: string; password?: string }) => Promise<void>;
  claimAdmin: (dashboardPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [needsAdminClaim, setNeedsAdminClaim] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ authenticated: boolean; user: CurrentUser | null; needsAdminClaim: boolean }>("/auth/me")
      .then(async (r) => {
        setUser(r.user);
        setNeedsAdminClaim(r.needsAdminClaim);
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
    setNeedsAdminClaim(!u.isUltimateAdmin);
  }

  async function setup(name: string, email: string, password: string, dashboardPassword: string) {
    const u = await api<CurrentUser>("/auth/setup", {
      method: "POST",
      body: JSON.stringify({ name, email, password, dashboardPassword }),
    });
    setUser(u);
    setNeedsSetup(false);
    setNeedsAdminClaim(false);
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  }

  async function updateProfile(fields: { name?: string; password?: string }) {
    const u = await api<CurrentUser>("/auth/me", { method: "PATCH", body: JSON.stringify(fields) });
    setUser(u);
  }

  async function claimAdmin(dashboardPassword: string) {
    const u = await api<CurrentUser>("/auth/claim-admin", { method: "POST", body: JSON.stringify({ dashboardPassword }) });
    setUser(u);
    setNeedsAdminClaim(false);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        authenticated: Boolean(user),
        loading,
        needsSetup,
        needsAdminClaim,
        login,
        setup,
        logout,
        updateProfile,
        claimAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
