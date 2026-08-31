import type { ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { Dashboard } from "./pages/Dashboard";
import { Employees } from "./pages/Employees";
import { Fines } from "./pages/Fines";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";
import { Tasks } from "./pages/Tasks";

function RequireAuth({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="center-loading">Зареждане…</p>;
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
        <Route path="/tasks" element={<Tasks />} />
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
