import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Group, Store } from "../api/types";
import { useAuth } from "./AuthContext";

interface StoreContextValue {
  stores: Store[];
  groups: Group[];
  currentStore: Store | null;
  setCurrentStoreId: (id: string) => void;
  loading: boolean;
  refreshStores: () => Promise<void>;
  refreshGroups: () => Promise<void>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { authenticated } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [currentStoreId, setCurrentStoreId] = useState<string>(() => localStorage.getItem("pp.storeId") ?? "");
  const [loading, setLoading] = useState(true);

  async function refreshStores() {
    const list = await api<Store[]>("/stores");
    setStores(list);
    // currentStoreId can point at a store that no longer exists — e.g. a
    // stale id left in localStorage from before that store was deleted and
    // re-added under a new id. Fall back to the first available store
    // rather than silently resolving to no selection.
    if (list.length > 0 && !list.some((s) => s.id === currentStoreId)) {
      setCurrentStoreId(list[0].id);
    } else if (list.length === 0 && currentStoreId) {
      setCurrentStoreId("");
    }
  }

  async function refreshGroups() {
    setGroups(await api<Group[]>("/groups"));
  }

  useEffect(() => {
    if (!authenticated) return;
    Promise.all([refreshStores(), refreshGroups()]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  useEffect(() => {
    if (currentStoreId) localStorage.setItem("pp.storeId", currentStoreId);
    else localStorage.removeItem("pp.storeId");
  }, [currentStoreId]);

  const currentStore = stores.find((s) => s.id === currentStoreId) ?? null;

  return (
    <StoreContext.Provider
      value={{ stores, groups, currentStore, setCurrentStoreId, loading, refreshStores, refreshGroups }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStores(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStores must be used within StoreProvider");
  return ctx;
}
