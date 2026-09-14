import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useStores } from "../context/StoreContext";

export function Layout() {
  const { logout } = useAuth();
  const { stores, currentStore, setCurrentStoreId, loading } = useStores();

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span className="brand-text">PricePilot</span>
        </div>

        <div className="store-switcher">
          {loading ? (
            <span className="muted">Loading stores…</span>
          ) : stores.length === 0 ? (
            <span className="muted">No stores yet — add one in Settings</span>
          ) : (
            <select value={currentStore?.id ?? ""} onChange={(e) => setCurrentStoreId(e.target.value)}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.marketCode})
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="topnav">
          <NavLink to="/" end>
            Pricing
          </NavLink>
          <NavLink to="/unmatched">Unmatched</NavLink>
          <NavLink to="/publish-log">Publish log</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>

        <button className="secondary" onClick={() => logout()}>
          Log out
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
