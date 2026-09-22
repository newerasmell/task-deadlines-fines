import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SalesResponse, Store } from "../api/types";
import { useStores } from "../context/StoreContext";

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
      title="Средна себестойност за цялата категория — fallback само за продукти без собствена себестойност от costs.csv"
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
        placeholder="min"
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
        placeholder="max"
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
  const [enabled, setEnabled] = useState(store.markdownEnabled);
  const [collectionId, setCollectionId] = useState(store.markdownCollectionId ?? "");
  const [afterDays, setAfterDays] = useState(String(store.markdownAfterDays));
  const [ceilingPct, setCeilingPct] = useState(String(store.markdownCeilingPct));
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
      <h2>Намаляване на нови пристигания</h2>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
        Продукт от избраната колекция, станал "active" в Shopify преди повече от зададените дни, се маркира в Pricing
        за намаляване — до таван от зададения % над цената по формулата, с истинската начална цена като compare-at.
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
          Включено
        </label>
        <label>
          Колекция за нови пристигания
          <select
            value={collectionId}
            disabled={saving}
            onChange={(e) => {
              setCollectionId(e.target.value);
              save({ markdownCollectionId: e.target.value || null });
            }}
          >
            <option value="">— избери колекция —</option>
            {categories.map((c) => (
              <option key={c.categoryId} value={c.categoryId}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Дни от "active"
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
          Таван над формулата, %
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
      </div>
    </div>
  );
}

export function Sales() {
  const { currentStore, refreshStores } = useStores();
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

  if (!currentStore) return <p className="muted">No store selected.</p>;
  if (loading) return <p className="center-loading">Loading…</p>;
  if (!data) return null;

  if (!data.salesAnalyticsEnabled) {
    return (
      <div>
        <h1>Продажби</h1>
        <p className="muted" style={{ marginTop: 12 }}>
          Тази функция не е включена за {currentStore.name}. Включи я от Stores → {currentStore.name} → Connection
          &amp; pricing rule.
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
        <h1>Продажби — {currentStore.name}</h1>
        <span className="muted small">Последните 6 месеца</span>
      </div>

      {data.pricingProfile === "cod_formula" && (
        <MarkdownSettingsPanel store={currentStore} categories={data.categories} onSaved={refreshStores} />
      )}

      <div className="settings-section">
        <h2>По категория</h2>
        {data.pricingProfile === "cod_formula" && (
          <p className="muted small" style={{ marginTop: -4, marginBottom: 8 }}>
            Базовата цена min–max, заедно с коефициентите в Марки, дават предложената "базова цена" на Pricing таба.
          </p>
        )}
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>Категория</th>
                <th># продукти</th>
                <th>Продадени бр.</th>
                <th>Средна продажна цена</th>
                <th>Посещения</th>
                <th>Conv. rate</th>
                {data.pricingProfile === "cod_formula" && (
                  <>
                    <th>Себестойност (ръчно)</th>
                    <th>Базова цена min–max (ръчно)</th>
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
                    Няма синхронизирани колекции още — пусни "Sync now" от Stores.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="settings-section">
        <h2>По продукт</h2>
        <div className="filters-bar">
          <input placeholder="Търси по заглавие" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>Продукт</th>
                <th>Категории</th>
                <th>Наличност</th>
                <th>Продадени бр. (6м)</th>
                <th>Средна продажна цена</th>
                <th>Посещения (6м)</th>
                <th>Conv. rate</th>
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
                    Няма продукти.
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
