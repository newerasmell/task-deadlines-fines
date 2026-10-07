// Prices in a store's own currency from an amount in euros: the same rule as pipeline/fx.py round_price, so the
// row shows exactly what will be saved. Rates are the ECB's (1 EUR = x).

const STEP: Record<string, number> = { CZK: 10, HUF: 100, ISK: 100, JPY: 100, KRW: 1000 }

export function roundPrice(value: number, currency: string, cents?: string | null): string {
  const step = STEP[currency]
  if (step) return String(Math.max(step, Math.round(value / step) * step))
  if (cents && /^\d{2}$/.test(cents) && cents !== '00') {
    const whole = Math.floor(value)
    const end = Number(cents) / 100
    const candidate = [whole - 1 + end, whole + end].reduce((a, b) =>
      Math.abs(b - value) < Math.abs(a - value) ? b : a,
    )
    return Math.max(candidate, end).toFixed(2)
  }
  return String(Math.round(value))
}

export function parseAmount(text: string): number | null {
  const n = Number(text.replace(',', '.').trim())
  return text.trim() && Number.isFinite(n) && n > 0 ? n : null
}

/** Local price for an amount in euros; '' for an empty entry, null when there is no rate. */
export function fromEur(text: string, currency: string, rates?: Record<string, number>, cents?: string | null) {
  if (!text.trim()) return ''
  const eur = parseAmount(text)
  const rate = rates?.[currency]
  if (eur == null || !rate) return null
  return roundPrice(eur * rate, currency, cents)
}

export function toEur(local: string, currency: string, rates?: Record<string, number>): string {
  const n = parseAmount(local)
  const rate = rates?.[currency]
  return n != null && rate ? (n / rate).toFixed(2) : ''
}
