// How a store profile (pipeline/detect.py) reads in the app: one row per property, in Bulgarian.
import type { ProfileItem, StoreProfile } from './api'
import { languageName } from './labels'

export type Row = {
  key: string
  label: string
  value: string
  note: string
  match: string
  kind: 'ok' | 'confirm' | 'weak'
  editable: boolean
  raw: unknown
}

const pct = (r?: number | null) => (r == null ? '' : `${Math.round(r * 100)}%`)

const TOKENS: Record<string, string> = {
  brand: 'марка',
  name: 'име',
  concentration_short: 'концентрация',
  ml: 'ml',
  ean: 'EAN',
  title: 'заглавие',
}

export function formula(value: unknown): string {
  return String(value ?? '')
    .replace(/\{tester: '([^']*)'\}/g, (_, t) => ` [${t.trim()}]`)
    .replace(/\{(\w+)\}/g, (_, k) => `{${TOKENS[k] ?? k}}`)
}

function item(p: StoreProfile, key: string): ProfileItem | undefined {
  const v = p.profile.items[key]
  return v && typeof v === 'object' && 'value' in v ? (v as ProfileItem) : undefined
}

function kind(it?: ProfileItem): Row['kind'] {
  if (!it) return 'ok'
  if (it.status === 'suggested') return (it.match_rate ?? 1) < 0.7 ? 'weak' : 'confirm'
  return 'ok'
}

function counts(it: ProfileItem | undefined, key = 'counts'): string {
  const c = it?.[key] as Record<string, number> | undefined
  if (!c) return ''
  return Object.entries(c)
    .slice(0, 4)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
}

export function rows(p: StoreProfile): Row[] {
  const out: Row[] = []
  const add = (key: string, label: string, value: string, note = '', editable = false) => {
    const it = item(p, key)
    if (!it && !value) return
    out.push({
      key,
      label,
      value,
      note,
      match: it?.status === 'accepted' ? 'потвърдено' : pct(it?.match_rate),
      kind: it?.status === 'accepted' ? 'ok' : kind(it),
      editable,
      raw: it?.value,
    })
  }
  const lang = item(p, 'content_language')
  add('content_language', 'Език на съдържанието', `${languageName(String(lang?.value ?? ''))} (${lang?.value ?? '?'})`,
    `от описанията и нотките: ${counts(lang)}`, true)
  const notes = item(p, 'notes_language')
  if (notes) add('notes_language', 'Език на нотките', `${languageName(String(notes.value))} (${notes.value})`, counts(notes), true)
  const markets = (item(p, 'markets')?.value as { market: string; country: string; currency: string }[]) ?? []
  add(
    'currency',
    'Валута',
    String(item(p, 'currency')?.value ?? '?'),
    `само код, напр. EUR${markets.length ? ` · пазари от експорта: ${markets.map((m) => m.market).join(', ')}` : ''}`,
    true,
  )
  const title = item(p, 'title_pattern')
  const tester = item(p, 'tester_marker')
  add('title_pattern', 'Заглавие', formula(title?.value), tester ? `маркер за тестер „${tester.value}“` : '', true)
  add('handle', 'Handle', String(item(p, 'handle')?.value ?? ''), '', true)
  const sku = item(p, 'sku_pattern')
  const ean = item(p, 'ean_location')
  add('sku_pattern', 'SKU', formula(sku?.value), ean ? `EAN се чете от ${ean.value}` : '', true)
  const meta = (item(p, 'metafields')?.value as { namespace: string; key: string }[]) ?? []
  const custom = meta.filter((m) => m.namespace === 'custom')
  add('metafields', 'Метаполета', `${custom.length} в custom: ${custom.map((m) => m.key).join(', ')}`,
    meta.length > custom.length ? `и ${meta.length - custom.length} в други пространства` : '')
  const vocab = p.profile.items.vocab as Record<string, ProfileItem> | undefined
  for (const [field, label] of [['gender', 'Пол'], ['fragrance_family', 'Семейство']] as const) {
    const v = vocab?.[field]
    if (!v) continue
    const values = (v.value as string[]) ?? []
    const canonical = (v.canonical as Record<string, { variants?: Record<string, number> }>) ?? {}
    const spellings = Object.values(canonical).reduce((n, c) => n + Object.keys(c?.variants ?? {}).length, 0)
    out.push({
      key: `vocab.${field}`,
      label,
      value: values.slice(0, 6).join(', ') + (values.length > 6 ? ` и още ${values.length - 6}` : ''),
      note: spellings ? `${spellings} изписвания ще се уеднаквят` : '',
      match: pct(v.match_rate),
      kind: kind(v),
      editable: false,
      raw: v.value,
    })
  }
  const shape = item(p, 'description_html')
  const len = item(p, 'description_length')
  add('description_html', 'Описание', `${shape?.value ?? ''}${len ? `, ${(len.value as number[]).join('–')} знака` : ''}`,
    item(p, 'tester_sentence')?.value ? `изречение за тестер: „${String(item(p, 'tester_sentence')?.value).slice(0, 60)}…“` : '', true)
  const rounding = item(p, 'price_rounding')
  const ratio = item(p, 'compare_at_ratio')
  add('compare_at_ratio', 'Цени', `завършват на ,${rounding?.value ?? '?'}; зачеркната ${((ratio?.value as number[]) ?? []).join('–')} пъти цената`,
    ratio?.p50 ? `обикновено ${String(ratio.p50).replace('.', ',')} пъти` : '')
  const fixed = p.profile.items.fixed_columns as Record<string, ProfileItem> | undefined
  if (fixed) {
    const list = Object.entries(fixed)
    const sure = list.filter(([, v]) => v.status !== 'suggested').length
    out.push({
      key: 'fixed_columns',
      label: 'Фиксирани полета',
      value: list.slice(0, 4).map(([k, v]) => `${k}: ${v.value}`).join(' · '),
      note: list.length > 4 ? `и още ${list.length - 4}` : '',
      match: `${sure} от ${list.length}`,
      kind: sure < list.length ? 'confirm' : 'ok',
      editable: false,
      raw: null,
    })
  }
  const gg = item(p, 'google_gender')
  if (gg) add('google_gender', 'Google пол', Object.entries(gg.value as Record<string, string>).map(([a, b]) => `${a} → ${b}`).join(', '))
  const pairs = item(p, 'note_pairs')
  if (pairs) {
    const all = Object.values((pairs.value as Record<string, unknown[]>) ?? {}).flat()
    add('note_pairs', 'Двойки нотки', `${all.length} двойки за речника`, pairs.reference ? `сравнени с ${pairs.reference}` : 'без втори магазин за сравнение')
  }
  return out
}
