import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { PricingProfile, PricingStrategy, Store } from "../api/types";
import { useStores } from "../context/StoreContext";

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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !clientSecret.trim()) {
      setError("Client secret is required.");
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
      };
      if (clientSecret.trim()) body.shopifyClientSecret = clientSecret.trim();

      if (isEdit) await api(`/stores/${store!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/stores", { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          myshopify.com domain
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
          Client ID
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </label>
        <label>
          Client secret {isEdit && <span className="muted">(leave blank to keep the current one)</span>}
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="shpss_…"
          />
        </label>
      </div>
      <p className="muted small">
        From your app's Dev Dashboard page (dev.shopify.com) → Settings → Credentials. Requires{" "}
        <code>read_products</code> and <code>write_products</code> scopes, installed to this store.
      </p>
      <div className="form-row">
        <label>
          Market code
          <input value={marketCode} onChange={(e) => setMarketCode(e.target.value)} placeholder="e.g. PL, GR, BG" required />
        </label>
        <label>
          Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="e.g. EUR" required />
        </label>
      </div>
      <label>
        Group
        <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Ungrouped</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label>
          Pricing profile
          <select value={pricingProfile} onChange={(e) => setPricingProfile(e.target.value as PricingProfile)}>
            <option value="competitor">Competitor tracking (undercut/match)</option>
            <option value="cod_formula">COD formula (cost + logistics + ad-spend based)</option>
          </select>
        </label>
      </div>
      {pricingProfile === "competitor" && (
        <>
          <div className="form-row">
            <label>
              Pricing strategy
              <select value={strategy} onChange={(e) => setStrategy(e.target.value as PricingStrategy)}>
                <option value="undercut_min">Undercut lowest</option>
                <option value="match_min">Match lowest</option>
                <option value="undercut_avg">Undercut average</option>
              </select>
            </label>
            <label>
              Undercut %
              <input type="number" step="0.1" value={undercutPct} onChange={(e) => setUndercutPct(e.target.value)} />
            </label>
          </div>
          <div className="form-row">
            <label>
              Price ending (optional)
              <input value={priceEnding} onChange={(e) => setPriceEnding(e.target.value)} placeholder=".99" />
            </label>
            <label>
              Min margin % (floor guard)
              <input type="number" step="0.1" value={minMarginPct} onChange={(e) => setMinMarginPct(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {pricingProfile === "cod_formula" && (
        <p className="muted small">The formula itself (cost mix, delivery scenarios, agency fee) is configured on the Pricing page once this store is saved.</p>
      )}
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Add store"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
