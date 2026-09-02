import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import { Avatar } from "./Avatar";
import { IconBoard, IconFines, IconLog, IconMe, IconPeople, IconRepeat, IconSettings, IconTasks } from "./icons";

export function Layout() {
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <aside className={`sidebar${menuOpen ? " sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-text">
            TODF
            <span className="brand-subtitle">{t("Задачи · Owners · Срокове · Глоби")}</span>
          </span>
          <button
            className="hamburger"
            aria-label={menuOpen ? t("Затвори менюто") : t("Отвори менюто")}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </div>
        <nav>
          <NavLink to="/my-tasks">
            <IconMe /> {t("Моите задачи")}
          </NavLink>
          <NavLink to="/" end>
            <IconBoard /> {t("Табло")}
          </NavLink>
          <NavLink to="/tasks">
            <IconTasks /> {t("Задачи")}
          </NavLink>
          <NavLink to="/recurring">
            <IconRepeat /> {t("Повтарящи се")}
          </NavLink>
          <NavLink to="/fines">
            <IconFines /> {t("Глоби")}
          </NavLink>
          {isAdmin && (
            <NavLink to="/employees">
              <IconPeople /> {t("Служители")}
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/settings">
              <IconSettings /> {t("Настройки")}
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/audit-log">
              <IconLog /> {t("Дневник")}
            </NavLink>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="lang-toggle">
            <button className={lang === "bg" ? "active" : ""} onClick={() => setLang("bg")}>
              БГ
            </button>
            <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
              EN
            </button>
          </div>
          {user && (
            <div className="user-chip">
              <Avatar id={user.id} name={user.name} />
              <div>
                <div className="user-name">{user.name}</div>
                <div className="user-role">{user.role === "ADMIN" ? t("Администратор") : t("Служител")}</div>
              </div>
            </div>
          )}
          <button className="link-btn" onClick={logout}>
            {t("Изход")}
          </button>
        </div>
      </aside>
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
