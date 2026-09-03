import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { I18nProvider, useT } from "./i18n/I18nContext";
import { AuditLog } from "./pages/AuditLog";
import { Dashboard } from "./pages/Dashboard";
import { Employees } from "./pages/Employees";
import { Fines } from "./pages/Fines";
import { Leave } from "./pages/Leave";
import { Login } from "./pages/Login";
import { MyTasks } from "./pages/MyTasks";
import { RecurringTasks } from "./pages/RecurringTasks";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  const t = useT();
  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactElement }) {
  const { user } = useAuth();
  if (user?.role !== "ADMIN") return <Navigate to="/" replace />;
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
        <Route path="/" element={<Dashboard />} />
        <Route path="/my-tasks" element={<MyTasks />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/recurring" element={<RecurringTasks />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/fines" element={<Fines />} />
        <Route
          path="/employees"
          element={
            <RequireAdmin>
              <Employees />
            </RequireAdmin>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAdmin>
              <Settings />
            </RequireAdmin>
          }
        />
        <Route
          path="/audit-log"
          element={
            <RequireAdmin>
              <AuditLog />
            </RequireAdmin>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </I18nProvider>
  );
}
