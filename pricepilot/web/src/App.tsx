import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { StoreProvider } from "./context/StoreContext";
import { AuditLog } from "./pages/AuditLog";
import { Login } from "./pages/Login";
import { PricingTable } from "./pages/PricingTable";
import { Unmatched } from "./pages/Unmatched";
import { PublishLog } from "./pages/PublishLog";
import { Settings } from "./pages/Settings";

function RequireAuth({ children }: { children: ReactElement }) {
  const { authenticated, loading } = useAuth();
  if (loading) return <p className="center-loading">Loading…</p>;
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
        <Route path="/audit-log" element={<AuditLog />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <StoreProvider>
        <AppRoutes />
      </StoreProvider>
    </AuthProvider>
  );
}
