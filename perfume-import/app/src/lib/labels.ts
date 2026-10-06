// Bulgarian labels for the app (UI language: Bulgarian; product content stays in the store's language).
import type { FieldRecord, Product, Status, StoreInfo } from './api'

export const STATUS_ORDER: Status[] = ['blocked', 'warning', 'suggested', 'fixed', 'ok']
export const SEVERITY: Record<Status, number> = { blocked: 4, warning: 3, suggested: 2, fixed: 1, ok: 0 }

// Tag above a value (product view) and filter chip names (grid), as in the mockups.
export const STATUS_TAG: Record<Status, string> = {
  ok: 'ok',
  suggested: 'AI предложение',
  fixed: 'поправено',
  warning: 'внимание',
  blocked: 'спряно',
}
export const STATUS_FILTER: Record<Status, string> = {
  ok: 'Готови',
  suggested: 'AI предложения',
  fixed: 'Автоматично поправени',
  warning: 'Предупреждения',
  blocked: 'Спрени',
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Заглавие',
  handle: 'Handle',
  sku: 'SKU',
  ean: 'EAN',
  vendor: 'Марка',
  name: 'Име',
  concentration: 'Концентрация',
  seo_title: 'SEO заглавие',
  seo_description: 'SEO описание',
  body_html: 'Описание',
  gender: 'Пол',
  fragrance_family: 'Семейство',
  top_note: 'Горни нотки',
  middle_note: 'Средни нотки',
  base_note: 'Базови нотки',
  ingredients: 'Съставки',
  price: 'Цена',
  compare_at: 'Зачеркната',
  image: 'Снимка',
  product_milliliters: 'Обем',
  'custom.product_milliliters': 'Обем',
  product_type: 'Тип',
  'custom.product_type': 'Тип',
  'google.gender': 'Google пол',
  'google.product_category': 'Google категория',
  'google.condition': 'Google състояние',
}

export function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  if (key.startsWith('fixed.')) return key.slice(6)
  return key
}

// The fields a person reviews, in the order of the product view; fixed Shopify columns come last.
export const REVIEW_FIELDS = [
  'fragrance_family',
  'gender',
  'top_note',
  'middle_note',
  'base_note',
  'body_html',
  'seo_description',
  'price',
  'compare_at',
]
export const IDENTITY_FIELDS = ['title', 'vendor', 'name', 'concentration', 'ean', 'sku', 'seo_title', 'ingredients']

export const LOCALIZED = new Set(['top_note', 'middle_note', 'base_note', 'body_html', 'seo_description', 'seo_title'])

export function storeShort(store: StoreInfo): string {
  return store.country ?? store.key
}

export function storeLong(store: StoreInfo): string {
  return `${store.label} ${store.country ?? ''}`.trim()
}

const LANGUAGES: Record<string, string> = {
  el: 'гръцки',
  hr: 'хърватски',
  cs: 'чешки',
  hu: 'унгарски',
  pl: 'полски',
  sl: 'словенски',
  sk: 'словашки',
  en: 'английски',
  bg: 'български',
  ro: 'румънски',
  et: 'естонски',
  lt: 'литовски',
  lv: 'латвийски',
  de: 'немски',
  fr: 'френски',
  it: 'италиански',
}

export function languageName(code: string | null): string {
  return (code && LANGUAGES[code]) || code || ''
}

const MONTHS = ['ян.', 'февр.', 'март', 'апр.', 'май', 'юни', 'юли', 'авг.', 'септ.', 'окт.', 'ноем.', 'дек.']

export function shortDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function groupLabel(key: string): string {
  const m = key.match(/^group-(\d+)$/)
  return m ? `Група ${m[1]}` : key
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function display(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'да' : 'не'
  return String(value)
}

export function stripHtml(value: unknown): string {
  return display(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

export function host(url: string | null | undefined): string {
  if (!url) return ''
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Every field of every store, flattened. */
export function allFields(product: Product): FieldRecord[] {
  return Object.values(product.stores).flatMap((s) => Object.values(s.fields))
}

export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ok')
}

/** One line under the product name in the list: what still needs a person, or "готов". */
export function productNote(product: Product): { text: string; status: Status } {
  const fields = allFields(product)
  const count = (s: Status) => fields.filter((f) => f.status === s).length
  const blocked = count('blocked')
  const suggested = count('suggested')
  const warning = count('warning')
  const fixed = count('fixed')
  const parts: string[] = []
  if (suggested) parts.push(plural(suggested, 'предложение', 'предложения'))
  if (blocked) parts.push(`${blocked} ${blocked === 1 ? 'спряно' : 'спрени'}`)
  if (warning) parts.push(plural(warning, 'предупреждение', 'предупреждения'))
  const approved = Object.values(product.stores).every((s) => s.approved_at)
  if (!parts.length) {
    const base = approved ? 'одобрен' : 'готов'
    return { text: fixed ? `${base}, ${plural(fixed, 'поправка', 'поправки')}` : base, status: 'ok' }
  }
  return { text: parts.join(', '), status: blocked ? 'blocked' : suggested ? 'suggested' : 'warning' }
}
