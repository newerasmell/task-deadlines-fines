import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/client";
import type { Store } from "../api/types";
import { useAuth } from "./AuthContext";

interface StoreContextValue {
  stores: Store[];
  currentStore: Store | null;
  setCurrentStoreId: (id: string) => void;
  loading: boolean;
  refreshStores: () => Promise<void>;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const { authenticated } = useAuth();
  const [stores, setStores] = useState<Store[]>([]);
  const [currentStoreId, setCurrentStoreId] = useState<string>(() => localStorage.getItem("pp.storeId") ?? "");
  const [loading, setLoading] = useState(true);

  async function refreshStores() {
    const list = await api<Store[]>("/stores");
    setStores(list);
    if (!currentStoreId && list.length > 0) {
      setCurrentStoreId(list[0].id);
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    refreshStores().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  useEffect(() => {
    if (currentStoreId) localStorage.setItem("pp.storeId", currentStoreId);
  }, [currentStoreId]);

  const currentStore = stores.find((s) => s.id === currentStoreId) ?? null;

  return (
    <StoreContext.Provider value={{ stores, currentStore, setCurrentStoreId, loading, refreshStores }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStores(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStores must be used within StoreProvider");
  return ctx;
}
