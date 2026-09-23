import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { PricingProfile, PricingStrategy, Store } from "../api/types";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";

export function StoreForm({
  store,
  defaultGroupId,
  onDone,
  onCancel,
}: {
  store: Store | null;
  // Pre-selected group when creating a NEW store from inside that group's
  // section on the Stores page — ignored when editing an existing store.
  defaultGroupId?: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const { groups } = useStores();
  const isEdit = Boolean(store);
  const [name, setName] = useState(store?.name ?? "");
  const [domain, setDomain] = useState(store?.myshopifyDomain ?? "");
  const [clientId, setClientId] = useState(store?.shopifyClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [marketCode, setMarketCode] = useState(store?.marketCode ?? "");
  const [currency, setCurrency] = useState(store?.currency ?? "EUR");
  const [groupId, setGroupId] = useState(store?.groupId ?? defaultGroupId ?? "");
  const [pricingProfile, setPricingProfile] = useState<PricingProfile>(store?.pricingProfile ?? "competitor");
  const [strategy, setStrategy] = useState<PricingStrategy>(store?.pricingStrategy ?? "undercut_min");
  const [undercutPct, setUndercutPct] = useState(String(store?.undercutPct ?? 1));
  const [priceEnding, setPriceEnding] = useState(store?.priceEnding ?? "");
  const [minMarginPct, setMinMarginPct] = useState(String(store?.minMarginPct ?? 10));
  const [salesAnalyticsEnabled, setSalesAnalyticsEnabled] = useState(store?.salesAnalyticsEnabled ?? false);
  const [ga4PropertyId, setGa4PropertyId] = useState(store?.ga4PropertyId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !clientSecret.trim()) {
      setError(t("Клиентската тайна е задължителна."));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name,
        myshopifyDomain: domain,
        shopifyClientId: clientId.trim(),
        marketCode,
        currency,
        groupId: groupId || null,
        pricingProfile,
        pricingStrategy: strategy,
        undercutPct: Number(undercutPct),
        priceEnding: priceEnding.trim() || null,
        minMarginPct: Number(minMarginPct),
        salesAnalyticsEnabled,
        ga4PropertyId: ga4PropertyId.trim() || null,
      };
      if (clientSecret.trim()) body.shopifyClientSecret = clientSecret.trim();

      if (isEdit) await api(`/stores/${store!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/stores", { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          {t("Име")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          {t("myshopify.com домейн")}
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="your-store.myshopify.com"
            required
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          {t("Клиентски ID")}
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </label>
        <label>
          {t("Клиентска тайна")} {isEdit && <span className="muted">{t("(оставете празно, за да запазите текущата)")}</span>}
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="shpss_…"
          />
        </label>
      </div>
      <p className="muted small">
        {t("От страницата Dev Dashboard на приложението ви (dev.shopify.com) → Settings → Credentials. Изисква")}{" "}
        <code>read_products</code> {t("и")} <code>write_products</code> {t("права, инсталирани в този магазин.")}
      </p>
      <div className="form-row">
        <label>
          {t("Код на пазара")}
          <input value={marketCode} onChange={(e) => setMarketCode(e.target.value)} placeholder={t("напр. PL, GR, BG")} required />
        </label>
        <label>
          {t("Валута")}
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder={t("напр. EUR")} required />
        </label>
      </div>
      <label>
        {t("Група")}
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">{t("Без група")}</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label>
          {t("Ценови профил")}
          <select value={pricingProfile} onChange={(e) => setPricingProfile(e.target.value as PricingProfile)}>
            <option value="competitor">{t("Проследяване на конкуренти (подбиване/изравняване)")}</option>
            <option value="cod_formula">{t("COD формула (базирана на себестойност + логистика + разходи за реклама)")}</option>
          </select>
        </label>
      </div>
      {pricingProfile === "competitor" && (
        <>
          <div className="form-row">
            <label>
              {t("Ценова стратегия")}
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as PricingStrategy)}>
                <option value="undercut_min">{t("Подбий най-ниската")}</option>
                <option value="match_min">{t("Изравни с най-ниската")}</option>
                <option value="undercut_avg">{t("Подбий средната")}</option>
              </select>
            </label>
            <label>
              {t("Процент подбиване")}
              <input type="number" step="0.1" value={undercutPct} onChange={(e) => setUndercutPct(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <label>
              {t("Завършек на цената (незадължително)")}
              <input value={priceEnding} onChange={(e) => setPriceEnding(e.target.value)} placeholder=".99" />
            </label>
            <label>
              {t("Мин. марж % (долна граница)")}
              <input type="number" step="0.1" value={minMarginPct} onChange={(e) => setMinMarginPct(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {pricingProfile === "cod_formula" && (
        <p className="muted small">
          {t("Самата формула (микс от разходи, сценарии за доставка, агентска такса) се конфигурира на страница Ценообразуване, след като магазинът бъде запазен.")}
        </p>
      )}

      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={salesAnalyticsEnabled}
          onChange={(e) => setSalesAnalyticsEnabled(e.target.checked)}
        />
        {t('Активирай раздел „Продажби“ (продадени бройки за 6 месеца / средна продажна цена / обобщение по категория)')}
      </label>
      {salesAnalyticsEnabled && (
        <>
          <p className="muted small">
            {t("Изисква права")} <code>read_orders</code>{" "}
            {t("предоставени на Shopify приложението на този магазин — добавете ги в dev.shopify.com → your app → Configuration, след което преинсталирайте в магазина.")}
          </p>
          <label>
            {t("GA4 property (незадължително, за прегледи на страници/конверсия)")}
            <input
              value={ga4PropertyId}
              onChange={(e) => setGa4PropertyId(e.target.value)}
              placeholder="properties/123456789"
            />
          </label>
        </>
      )}
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Запазване…") : isEdit ? t("Запази промените") : t("Добави магазин")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
