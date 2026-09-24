import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SalesResponse, Store } from "../api/types";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";

function fmt(n: number | null, digits = 2): string {
  return n == null ? "—" : n.toFixed(digits);
}

// Editable "average acquisition cost" cell for one category — only wired to
// actually change pricing when the store is on pricingProfile=cod_formula
// (codPricingEngine.ts falls back to this only for a product with no
// SKU/EAN cost imported). Same always-visible-input + save-on-blur pattern
// as the per-product cost cell on the COD Pricing table.
function CategoryCostCell({
  categoryId,
  cost,
  onSaved,
}: {
  categoryId: string;
  cost: number | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(cost != null ? String(cost) : "");
  const [saving, setSaving] = useState(false);

  async function save(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (cost == null) return;
      setSaving(true);
      try {
        await api(`/sales/category/${categoryId}/cost`, { method: "DELETE" });
        onSaved();
      } finally {
        setSaving(false);
      }
      return;
    }
    const n = Number(trimmed);
    if (Number.isNaN(n) || n <= 0 || n === cost) return;
    setSaving(true);
    try {
      await api(`/sales/category/${categoryId}/cost`, { method: "PUT", body: JSON.stringify({ cost: n }) });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="suggested-input"
      type="number"
      step="0.01"
      min="0"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => save(e.target.value)}
      placeholder="—"
      disabled={saving}
      title={t("Средна себестойност за цялата категория — fallback само за продукти без собствена себестойност от costs.csv")}
    />
  );
}

// Editable [min, max] envelope for the category's suggested base/compare-at
// price — both values are saved together (the backend rejects a partial
// pair), since a lone min or max can't place anything "between" them. Feeds
// codPricingEngine.ts's basePriceFor, which also needs brand coefficients
// set on the Марки tab before it'll actually suggest a number.
function CategoryBasePriceCell({
  categoryId,
  baseMinPrice,
  baseMaxPrice,
  onSaved,
}: {
  categoryId: string;
  baseMinPrice: number | null;
  baseMaxPrice: number | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [min, setMin] = useState(baseMinPrice != null ? String(baseMinPrice) : "");
  const [max, setMax] = useState(baseMaxPrice != null ? String(baseMaxPrice) : "");
  const [saving, setSaving] = useState(false);

  async function save() {
    const minN = Number(min);
    const maxN = Number(max);
    if (!min.trim() || !max.trim() || Number.isNaN(minN) || Number.isNaN(maxN) || minN <= 0 || maxN < minN) return;
    if (minN === baseMinPrice && maxN === baseMaxPrice) return;
    setSaving(true);
    try {
      await api(`/sales/category/${categoryId}/base-price`, {
        method: "PUT",
        body: JSON.stringify({ baseMinPrice: minN, baseMaxPrice: maxN }),
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <input
        className="suggested-input"
        style={{ width: 68 }}
        type="number"
        step="0.01"
        min="0"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        onBlur={save}
        placeholder={t("мин")}
        disabled={saving}
      />
      <span className="muted">–</span>
      <input
        className="suggested-input"
        style={{ width: 68 }}
        type="number"
        step="0.01"
        min="0"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        onBlur={save}
        placeholder={t("макс")}
        disabled={saving}
      />
    </span>
  );
}

// New-arrival markdown config — a product tagged into `markdownCollectionId`
// starts a countdown the moment it's first synced ACTIVE in Shopify; once
// `markdownAfterDays` pass, if its price is still more than `markdownCeilingPct`
// above the formula's recommended price, the Pricing table flags it and
// suggests marking it down to exactly that ceiling. Saved onto the Store
// row itself (PATCH /stores/:id) since it's one set of numbers per store,
// same as the rest of its pricing rule.
function MarkdownSettingsPanel({
  store,
  categories,
  onSaved,
}: {
  store: Store;
  categories: { categoryId: string; title: string }[];
  onSaved: () => void;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(store.markdownEnabled);
  const [collectionId, setCollectionId] = useState(store.markdownCollectionId ?? "");
  const [afterDays, setAfterDays] = useState(String(store.markdownAfterDays));
  const [ceilingPct, setCeilingPct] = useState(String(store.markdownCeilingPct));
  const [newArrivalTag, setNewArrivalTag] = useState(store.newArrivalTag);
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      await api(`/stores/${store.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2>{t("Намаляване на нови пристигания")}</h2>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
        {t(
          'Продукт от избраната колекция, станал "active" в Shopify преди повече от зададените дни, се маркира в Pricing за намаляване — до таван от зададения % над цената по формулата, с истинската начална цена като compare-at.'
        )}
      </p>
      <div className="form-row">
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => {
              setEnabled(e.target.checked);
              save({ markdownEnabled: e.target.checked });
            }}
          />
          {t("Включено")}
        </label>
        <label>
          {t("Колекция за нови пристигания")}
          <select
            value={collectionId}
            disabled={saving}
            onChange={(e) => {
              setCollectionId(e.target.value);
              save({ markdownCollectionId: e.target.value || null });
            }}
          >
            <option value="">{t("— избери колекция —")}</option>
            {categories.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('Дни от "active"')}
          <input
            type="number"
            step="1"
            min="1"
            value={afterDays}
            disabled={saving}
            onChange={(e) => setAfterDays(e.target.value)}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n > 0 && n !== store.markdownAfterDays) save({ markdownAfterDays: n });
            }}
          />
        </label>
        <label>
          {t("Таван над формулата, %")}
          <input
            type="number"
            step="0.5"
            min="0"
            value={ceilingPct}
            disabled={saving}
            onChange={(e) => setCeilingPct(e.target.value)}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n) && n >= 0 && n !== store.markdownCeilingPct) save({ markdownCeilingPct: n });
            }}
          />
        </label>
        <label>
          {t('Таг за "нов" (маха се при публикуване)')}
          <input
            value={newArrivalTag}
            disabled={saving}
            placeholder="c_newcollection"
            onChange={(e) => setNewArrivalTag(e.target.value)}
            onBlur={(e) => {
              if (e.target.value !== store.newArrivalTag) save({ newArrivalTag: e.target.value });
            }}
          />
        </label>
      </div>
      <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
        {t(
          'Ако продуктът има този таг в Shopify, той се маха автоматично в момента, в който публикуваш намалената цена за ред, маркиран за намаляване по-горе — витрината спира да го показва като "нов", защото вече е реално намален.'
        )}
      </p>
    </div>
  );
}

export function Sales() {
  const { currentStore, refreshStores } = useStores();
  const t = useT();
  const [data, setData] = useState<SalesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  async function refresh() {
    if (!currentStore) return;
    const res = await api<SalesResponse>(`/sales/${currentStore.id}`);
    setData(res);
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id]);

  if (!currentStore) return <p className="muted">{t("Няма избран магазин.")}</p>;
  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;
  if (!data) return null;

  if (!data.salesAnalyticsEnabled) {
    return (
      <div>
        <h1>{t("Продажби")}</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          {t("Тази функция не е включена за {name}. Включи я от Stores → {name} → Connection & pricing rule.", {
            name: currentStore.name,
          })}
        </p>
      </div>
    );
  }

  const categoriesById = new Map(data.categories.map((c) => [c.categoryId, c.title]));
  const filteredProducts = data.products.filter(
    (p) => !search.trim() || p.title.toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t("Продажби — {name}", { name: currentStore.name })}</h1>
        <span className="muted small">{t("Последните 6 месеца")}</span>
      </div>

      {data.pricingProfile === "cod_formula" && (
        <MarkdownSettingsPanel store={currentStore} categories={data.categories} onSaved={refreshStores} />
      )}

      <div className="settings-section">
        <h2>{t("По категория")}</h2>
        {data.pricingProfile === "cod_formula" && (
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            {t('Базовата цена min–max, заедно с коефициентите в Марки, дават предложената "базова цена" на Pricing таба.')}
          </p>
        )}
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>{t("Категория")}</th>
                <th>{t("# продукти")}</th>
                <th>{t("Продадени бр.")}</th>
                <th>{t("Средна продажна цена")}</th>
                <th>{t("Посещения")}</th>
                <th>{t("Конверсия")}</th>
                {data.pricingProfile === "cod_formula" && (
                  <>
                    <th>{t("Себестойност (ръчно)")}</th>
                    <th>{t("Базова цена min–max (ръчно)")}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {data.categories.map((c) => (
                <tr key={c.categoryId}>
                  <td>{c.title}</td>
                  <td>{c.productCount}</td>
                  <td>{c.unitsSold6m}</td>
                  <td>{c.avgSalePrice6m != null ? `${fmt(c.avgSalePrice6m)} ${data.currency}` : "—"}</td>
                  <td>{c.pageViews6m ?? "—"}</td>
                  <td>{c.convRate6m != null ? `${fmt(c.convRate6m, 1)}%` : "—"}</td>
                  {data.pricingProfile === "cod_formula" && (
                    <>
                      <td>
                        <CategoryCostCell categoryId={c.categoryId} cost={c.cost} onSaved={refresh} />
                      </td>
                      <td>
                        <CategoryBasePriceCell
                          categoryId={c.categoryId}
                          baseMinPrice={c.baseMinPrice}
                          baseMaxPrice={c.baseMaxPrice}
                          onSaved={refresh}
                        />
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {data.categories.length === 0 && (
                <tr>
                  <td colSpan={data.pricingProfile === "cod_formula" ? 8 : 6} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    {t('Няма синхронизирани колекции още — пусни "Sync now" от Stores.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="settings-section">
        <h2>{t("По продукт")}</h2>
        <div className="filters-bar">
          <input placeholder={t("Търси по заглавие")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>{t("Продукт")}</th>
                <th>{t("Категории")}</th>
                <th>{t("Наличност")}</th>
                <th>{t("Продадени бр. (6м)")}</th>
                <th>{t("Средна продажна цена")}</th>
                <th>{t("Посещения (6м)")}</th>
                <th>{t("Конверсия")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredProducts.map((p) => (
                <tr key={p.productId}>
                  <td>{p.title}</td>
                  <td className="muted small">{p.categoryIds.map((id) => categoriesById.get(id)).filter(Boolean).join(", ") || "—"}</td>
                  <td>{p.inventoryQuantity ?? "—"}</td>
                  <td>{p.unitsSold6m}</td>
                  <td>{p.avgSalePrice6m != null ? `${fmt(p.avgSalePrice6m)} ${data.currency}` : "—"}</td>
                  <td>{p.pageViews6m ?? "—"}</td>
                  <td>{p.convRate6m != null ? `${fmt(p.convRate6m, 1)}%` : "—"}</td>
                </tr>
              ))}
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    {t("Няма продукти.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
