import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { StoreProvider } from "./context/StoreContext";
import { I18nProvider, useT } from "./i18n/I18nContext";
import { AuditLog } from "./pages/AuditLog";
import { Brands } from "./pages/Brands";
import { Login } from "./pages/Login";
import { PricingTable } from "./pages/PricingTable";
import { Unmatched } from "./pages/Unmatched";
import { PublishLog } from "./pages/PublishLog";
import { Sales } from "./pages/Sales";
import { Settings } from "./pages/Settings";
import { Stores } from "./pages/Stores";
import { StoreSettings } from "./pages/StoreSettings";

function RequireAuth({ children }: { children: ReactElement }) {
  const { authenticated, loading } = useAuth();
  const t = useT();
  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;
  if (!authenticated) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<PricingTable />} />
        <Route path="/unmatched" element={<Unmatched />} />
        <Route path="/publish-log" element={<PublishLog />} />
        <Route path="/sales" element={<Sales />} />
        <Route path="/brands" element={<Brands />} />
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/stores" element={<Stores />} />
        <Route path="/stores/:storeId" element={<StoreSettings />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <StoreProvider>
          <AppRoutes />
        </StoreProvider>
      </AuthProvider>
    </I18nProvider>
  );
}
