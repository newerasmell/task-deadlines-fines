import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useStores } from "../context/StoreContext";

export function Layout() {
  const { user, logout } = useAuth();
  const { stores, groups, currentStore, setCurrentStoreId, loading } = useStores();

  const ungrouped = stores.filter((s) => !s.groupId);

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
            <span className="muted">No stores yet — add one under Stores</span>
          ) : (
            <select value={currentStore?.id ?? ""} onChange={(e) => setCurrentStoreId(e.target.value)}>
              {groups.map((g) => {
                const groupStores = stores.filter((s) => s.groupId === g.id);
                if (groupStores.length === 0) return null;
                return (
                  <optgroup key={g.id} label={g.name}>
                    {groupStores.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.marketCode})
                      </option>
                    ))}
                  </optgroup>
                );
              })}
              {ungrouped.length > 0 && (
                <optgroup label={groups.length > 0 ? "Ungrouped" : ""}>
                  {ungrouped.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.marketCode})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
        </div>

        <nav className="topnav">
          <NavLink to="/" end>
            Pricing
          </NavLink>
          <NavLink to="/unmatched">Unmatched</NavLink>
          <NavLink to="/publish-log">Publish log</NavLink>
          {currentStore?.salesAnalyticsEnabled && <NavLink to="/sales">Продажби</NavLink>}
          {currentStore?.salesAnalyticsEnabled && currentStore?.pricingProfile === "cod_formula" && (
            <NavLink to="/brands">Марки</NavLink>
          )}
          <NavLink to="/audit-log">Audit log</NavLink>
          <NavLink to="/stores">Stores</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>

        {user && (
          <span className="muted small" title={user.email}>
            {user.name}
            {user.isUltimateAdmin && <span className="tag">admin</span>}
          </span>
        )}
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
