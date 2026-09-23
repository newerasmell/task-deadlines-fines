import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useStores } from "../context/StoreContext";
import { useI18n } from "../i18n/I18nContext";

export function Layout() {
  const { user, logout } = useAuth();
  const { stores, groups, currentStore, setCurrentStoreId, loading } = useStores();
  const { lang, setLang, t } = useI18n();

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
            <span className="muted">{t("Зареждане на магазините…")}</span>
          ) : stores.length === 0 ? (
            <span className="muted">{t("Все още няма магазини — добави от Магазини")}</span>
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
                <optgroup label={groups.length > 0 ? t("Без група") : ""}>
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
            {t("Ценообразуване")}
          </NavLink>
          <NavLink to="/unmatched">{t("Несъпоставени")}</NavLink>
          <NavLink to="/publish-log">{t("Дневник публикации")}</NavLink>
          {currentStore?.salesAnalyticsEnabled && <NavLink to="/sales">{t("Продажби")}</NavLink>}
          {currentStore?.salesAnalyticsEnabled && currentStore?.pricingProfile === "cod_formula" && (
            <NavLink to="/brands">{t("Марки")}</NavLink>
          )}
          <NavLink to="/audit-log">{t("Одит лог")}</NavLink>
          <NavLink to="/stores">{t("Магазини")}</NavLink>
          <NavLink to="/settings">{t("Настройки")}</NavLink>
        </nav>

        <div className="lang-toggle">
          <button className={lang === "bg" ? "active" : ""} onClick={() => setLang("bg")}>
            БГ
          </button>
          <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
            EN
          </button>
        </div>

        {user && (
          <span className="muted small" title={user.email}>
            {user.name}
            {user.isUltimateAdmin && <span className="tag">{t("админ")}</span>}
          </span>
        )}
        <button className="secondary" onClick={() => logout()}>
          {t("Изход")}
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
