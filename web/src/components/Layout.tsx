import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Layout() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Срокове &amp; Глоби</div>
        <nav>
          <NavLink to="/" end>
            Табло
          </NavLink>
          <NavLink to="/tasks">Задачи</NavLink>
          {isAdmin && <NavLink to="/recurring">Повтарящи се</NavLink>}
          <NavLink to="/fines">Глоби</NavLink>
          {isAdmin && <NavLink to="/employees">Служители</NavLink>}
          {isAdmin && <NavLink to="/settings">Настройки</NavLink>}
          {isAdmin && <NavLink to="/audit-log">Дневник</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div className="user-chip">
            <div className="user-name">{user?.name}</div>
            <div className="user-role">{user?.role === "ADMIN" ? "Администратор" : "Служител"}</div>
          </div>
          <button className="link-btn" onClick={logout}>
            Изход
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
