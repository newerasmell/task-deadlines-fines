import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, CircleAlert, ImageOff, RotateCcw, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { FieldPanel } from '../components/FieldPanel'
import { Failure, Loading } from '../components/States'
import { BAR, StatusMark, TAG_TEXT, TINT } from '../components/StatusMark'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import type { Batch, FieldRecord, Product, Status } from '../lib/api'
import { cn } from '../lib/cn'
import {
  display,
  fieldLabel,
  groupLabel,
  languageName,
  plural,
  shortDate,
  STATUS_FILTER,
  STATUS_TAG,
  storeShort,
  stripHtml,
} from '../lib/labels'
import { useAcceptColumn, useBatch, useDecide } from '../lib/queries'

// Batch grid (Main.dc.html): rows = products, columns = fields, tabs = stores; status-tinted cells; filters;
// keyboard: arrows move, Enter opens the field panel, A accepts, E edits, Esc closes.

type Col = { key: string; width: number; numeric?: boolean; withEn?: boolean; text?: boolean }

const COLUMNS: Col[] = [
  { key: 'sku', width: 150, numeric: true },
  { key: 'ean', width: 140, numeric: true },
  { key: 'gender', width: 140 },
  { key: 'fragrance_family', width: 150 },
  { key: 'top_note', width: 200, withEn: true },
  { key: 'middle_note', width: 200, withEn: true },
  { key: 'base_note', width: 200, withEn: true },
  { key: 'body_html', width: 260, withEn: true, text: true },
  { key: 'seo_description', width: 220, withEn: true, text: true },
  { key: 'price', width: 90, numeric: true },
  { key: 'compare_at', width: 100, numeric: true },
  { key: 'image', width: 90 },
]
const FIRST = 330
const ROW = 44
const FILTERS: Status[] = ['suggested', 'fixed', 'warning', 'blocked']
const ICON: Partial<Record<Status, LucideIcon>> = { fixed: RotateCcw, warning: TriangleAlert, blocked: CircleAlert }

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Product>()

export function GridScreen() {
  const batchId = Number(useParams().batchId)
  const batch = useBatch(batchId)
  if (batch.isPending) return <Loading what="партидата" />
  if (batch.isError) return <Failure error={batch.error} retry={() => batch.refetch()} />
  return <Grid batch={batch.data} />
}

function Grid({ batch }: { batch: Batch }) {
  const [params, setParams] = useSearchParams()
  const store = params.get('store') ?? batch.stores[0]?.key ?? ''
  const storeInfo = batch.stores.find((s) => s.key === store)
  const [filter, setFilter] = useState<Status | null>(null)
  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState({ row: 0, col: 0 })
  const [panel, setPanel] = useState<{ productId: number; key: string; edit: boolean } | null>(null)
  const [confirm, setConfirm] = useState<{ key: string; count: number } | null>(null)
  const decide = useDecide(batch.id)
  const acceptColumn = useAcceptColumn(batch.id)
  const scroller = useRef<HTMLDivElement>(null)

  const columns = useMemo(
    () => COLUMNS.filter((c) => batch.products.some((p) => p.stores[store]?.fields[c.key])),
    [batch.products, store],
  )
  const field = (p: Product, key: string): FieldRecord | undefined => p.stores[store]?.fields[key]

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: 0 }
    for (const p of batch.products)
      for (const c of columns) {
        const f = field(p, c.key)
        if (!f) continue
        out.all += 1
        out[f.status] = (out[f.status] ?? 0) + 1
      }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.products, columns, store])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return batch.products.filter((p) => {
      if (!p.stores[store]) return false
      if (filter && !columns.some((c) => field(p, c.key)?.status === filter)) return false
      if (!q) return true
      const hay = [p.title, display(field(p, 'sku')?.value), display(field(p, 'vendor')?.value), p.ean ?? '']
      return hay.some((h) => h.toLowerCase().includes(q))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.products, filter, search, store, columns])

  const tableColumns = useMemo(
    () =>
      helper.columns([
        helper.accessor((p) => p.title, { id: 'product', header: 'Продукт' }),
        ...columns.map((c) =>
          helper.accessor((p) => p.stores[store]?.fields[c.key], { id: c.key, header: fieldLabel(c.key) }),
        ),
      ]),
    [columns, store],
  )
  const table = useTable({ features, columns: tableColumns, data: rows, getRowId: (p) => String(p.id) })
  const tableRows = table.getRowModel().rows
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 12,
  })

  const width = FIRST + columns.reduce((s, c) => s + c.width, 0)
  const row = Math.min(cursor.row, Math.max(0, tableRows.length - 1))
  const col = Math.min(cursor.col, Math.max(0, columns.length - 1))
  const current = tableRows[row]?.original
  const currentField = current ? field(current, columns[col]?.key) : undefined
  const panelProduct = panel ? batch.products.find((p) => p.id === panel.productId) : undefined

  useEffect(() => {
    virtualizer.scrollToIndex(row, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row])

  // Arrows always move; A/E/Esc go to the panel when it is open (FieldPanel listens itself).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const move = (dr: number, dc: number) => {
        e.preventDefault()
        const next = {
          row: Math.max(0, Math.min(tableRows.length - 1, row + dr)),
          col: Math.max(0, Math.min(columns.length - 1, col + dc)),
        }
        setCursor(next)
        if (panel) {
          const p = tableRows[next.row]?.original
          if (p) setPanel({ productId: p.id, key: columns[next.col].key, edit: false })
        }
      }
      if (e.key === 'ArrowDown') move(1, 0)
      else if (e.key === 'ArrowUp') move(-1, 0)
      else if (e.key === 'ArrowRight') move(0, 1)
      else if (e.key === 'ArrowLeft') move(0, -1)
      else if (panel) return
      else if (e.key === 'Enter' && current && currentField) {
        e.preventDefault()
        setPanel({ productId: current.id, key: columns[col].key, edit: false })
      } else if (['a', 'A', 'а', 'А'].includes(e.key) && currentField) {
        e.preventDefault()
        if (['suggested', 'warning', 'fixed'].includes(currentField.status))
          decide.mutate({ fieldId: currentField.id, action: 'accept' })
      } else if (['e', 'E', 'е', 'Е'].includes(e.key) && current && currentField) {
        e.preventDefault()
        setPanel({ productId: current.id, key: columns[col].key, edit: true })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ready = rows.length ? summary(batch, store) : ''

  return (
    <div className="flex h-screen min-w-[1024px] flex-col bg-canvas">
      <header className="flex h-14 shrink-0 items-center gap-6 border-b border-line px-5">
        <div className="flex items-center gap-2 text-base">
          <Link to="/" className="text-ink-2 no-underline hover:text-ink">
            Партиди
          </Link>
          <span className="text-muted">/</span>
          {batch.kind === 'new' ? (
            <Link to={`/batches/${batch.id}`} className="font-semibold text-ink no-underline">
              {shortDate(batch.created_at)}, {groupLabel(batch.group)}
            </Link>
          ) : (
            <span className="font-semibold">
              Одит {storeInfo ? storeInfo.label : ''}, {shortDate(batch.created_at)}
            </span>
          )}
          <span className="text-ink-2">{plural(batch.products.length, 'продукт', 'продукта')}</span>
        </div>
        {batch.stores.length > 1 && (
          <nav className="ml-3 flex gap-0.5" aria-label="Сайтове">
            {batch.stores.map((s) => (
              <Button
                key={s.key}
                size="sm"
                className="h-8 px-3"
                variant={s.key === store ? 'dark' : 'secondary'}
                aria-current={s.key === store ? 'page' : undefined}
                onClick={() => setParams({ store: s.key })}
              >
                {s.label} {storeShort(s)}
              </Button>
            ))}
          </nav>
        )}
        <div className="grow" />
        {batch.kind === 'new' && (
          <Button asChild>
            <Link to={`/batches/${batch.id}/queue`}>Реши чакащите</Link>
          </Button>
        )}
      </header>

      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-5">
        <Button variant="chip" size="sm" aria-pressed={filter === null} onClick={() => setFilter(null)}>
          Всички полета <span className="tabular text-ink-2">{counts.all}</span>
        </Button>
        {FILTERS.map((s) => (
          <Button key={s} variant="chip" size="sm" aria-pressed={filter === s} onClick={() => setFilter(filter === s ? null : s)}>
            <StatusMark status={s} />
            {STATUS_FILTER[s]} <span className="tabular text-ink-2">{counts[s] ?? 0}</span>
          </Button>
        ))}
        <div className="grow" />
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <span className="hidden xl:inline">Търси</span>
          <input
            aria-label="Търси по марка, име или SKU"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="марка, име, SKU"
            className="h-[30px] w-[150px] rounded-md border border-line bg-canvas px-2.5 text-sm text-ink xl:w-[220px]"
          />
        </label>
      </div>

      <div className="flex min-h-0 grow">
        <div ref={scroller} className="min-w-0 grow overflow-auto" role="grid" aria-rowcount={tableRows.length} aria-label="Полета по продукт">
          <div style={{ width }} className="relative">
            <div role="row" className="sticky top-0 z-20 flex h-9 border-b border-line bg-canvas text-xs font-medium text-ink-2">
              <div role="columnheader" className="sticky left-0 z-10 flex items-center border-r border-line-2 bg-canvas px-2.5" style={{ width: FIRST }}>
                Продукт
              </div>
              {columns.map((c) => {
                const pending = rows.filter((p) => field(p, c.key)?.status === 'suggested').length
                return (
                  <div
                    role="columnheader"
                    key={c.key}
                    className={cn('flex items-center gap-1 border-r border-line-2 px-2.5', c.numeric && c.key !== 'sku' && c.key !== 'ean' && 'justify-end')}
                    style={{ width: c.width }}
                  >
                    <span className="truncate">
                      {fieldLabel(c.key)}
                      {c.withEn && storeInfo?.language && storeInfo.language !== 'en' ? ` (${storeInfo.language} + EN)` : ''}
                    </span>
                    {pending > 0 && (
                      <button
                        title={`Приеми всички ${pending} предложения в колоната`}
                        aria-label={`Приеми всички ${pending} предложения в колона ${fieldLabel(c.key)}`}
                        onClick={() => setConfirm({ key: c.key, count: pending })}
                        className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded-md border border-line bg-canvas px-1.5 text-xs text-suggested-text hover:bg-suggested-tint"
                      >
                        <Check size={12} /> {pending}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            <div style={{ height: virtualizer.getTotalSize() }} className="relative">
              {virtualizer.getVirtualItems().map((item) => {
                const r = tableRows[item.index]
                const p = r.original
                const thumb = display(field(p, 'image')?.value)
                return (
                  <div
                    role="row"
                    aria-rowindex={item.index + 1}
                    key={r.id}
                    className="absolute left-0 flex border-b border-line-2"
                    style={{ height: ROW, width, transform: `translateY(${item.start}px)` }}
                  >
                    <div
                      role="rowheader"
                      className="sticky left-0 z-10 flex items-center gap-2.5 overflow-hidden border-r border-line-2 bg-canvas px-2.5 text-sm"
                      style={{ width: FIRST }}
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded bg-well">
                        {thumb.startsWith('/api/media/') || thumb.startsWith('http') ? (
                          <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain" />
                        ) : (
                          <ImageOff size={14} className="text-muted" />
                        )}
                      </span>
                      {batch.kind === 'new' ? (
                        <Link to={`/batches/${batch.id}/products/${p.id}`} className="truncate text-ink no-underline hover:text-accent">
                          {p.title}
                        </Link>
                      ) : (
                        <span className="truncate">{p.title}</span>
                      )}
                    </div>
                    {columns.map((c, ci) => (
                      <GridCell
                        key={c.key}
                        col={c}
                        field={field(p, c.key)}
                        selected={item.index === row && ci === col}
                        onClick={() => {
                          setCursor({ row: item.index, col: ci })
                          if (field(p, c.key)) setPanel({ productId: p.id, key: c.key, edit: false })
                        }}
                      />
                    ))}
                  </div>
                )
              })}
            </div>
            {!tableRows.length && (
              <div className="p-7 text-sm text-ink-2">
                {filter ? `Няма полета със статус „${STATUS_FILTER[filter]}“ в ${storeInfo?.label ?? store}.` : 'Няма продукти по това търсене.'}
              </div>
            )}
          </div>
        </div>

        {panel && panelProduct && (
          <FieldPanel
            key={`${panel.productId}-${panel.key}-${store}`}
            batch={batch}
            product={panelProduct}
            store={store}
            fieldKey={panel.key}
            startEditing={panel.edit}
            onClose={() => setPanel(null)}
          />
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-5 border-t border-line bg-surface px-5 text-xs text-ink-2">
        <span>
          {storeInfo ? `${storeShort(storeInfo)} (${languageName(storeInfo.language)}): ` : ''}
          {ready}
        </span>
        {decide.isError && <span className="text-blocked-text">{(decide.error as Error).message}</span>}
        <div className="grow" />
        <span>Стрелки навигация · Enter детайли · A приеми · E промени · Esc затвори</span>
      </footer>

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm ? `Приеми ${confirm.count} предложения?` : ''}
        description={
          confirm
            ? `Всички предложения в колона „${fieldLabel(confirm.key)}“ за ${storeInfo?.label ?? store} стават приети с твоето име. Спрените полета не се променят.`
            : ''
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Откажи</Button>
            <Button
              variant="primary"
              disabled={acceptColumn.isPending}
              onClick={() =>
                confirm && acceptColumn.mutate({ store, key: confirm.key }, { onSuccess: () => setConfirm(null) })
              }
            >
              {confirm ? `Приеми ${confirm.count} в ${storeInfo ? storeShort(storeInfo) : store}` : ''}
            </Button>
          </>
        }
      />
    </div>
  )
}

function summary(batch: Batch, store: string): string {
  let ready = 0
  let review = 0
  let blocked = 0
  for (const p of batch.products) {
    const fields = Object.values(p.stores[store]?.fields ?? {})
    if (fields.some((f) => f.status === 'blocked')) blocked += 1
    else if (fields.some((f) => f.status === 'suggested')) review += 1
    else ready += 1
  }
  return [
    `${ready} ${ready === 1 ? 'готов' : 'готови'}`,
    `${review} ${review === 1 ? 'чака' : 'чакат'} преглед`,
    `${blocked} ${blocked === 1 ? 'спрян' : 'спрени'}`,
  ].join(', ')
}

function GridCell({ col, field, selected, onClick }: { col: Col; field?: FieldRecord; selected: boolean; onClick: () => void }) {
  const base = 'flex h-full shrink-0 overflow-hidden border-0 border-r border-line-2 px-2.5 text-left text-sm text-ink'
  if (!field) return <div role="gridcell" className={cn(base, 'items-center text-muted')} style={{ width: col.width }}>—</div>
  const value = col.key === 'image' ? imageLabel(field) : col.text ? stripHtml(field.value) : display(field.value)
  const en = col.withEn && field.value_en ? (col.text ? stripHtml(field.value_en) : field.value_en) : ''
  const right = col.numeric && col.key !== 'sku' && col.key !== 'ean'
  const Icon = ICON[field.status]
  return (
    <button
      role="gridcell"
      aria-selected={selected}
      title={field.message ?? undefined}
      onClick={onClick}
      tabIndex={selected ? 0 : -1}
      className={cn(
        base,
        TINT[field.status],
        BAR[field.status],
        en ? 'flex-col items-start justify-center gap-0' : 'items-center',
        right && 'justify-end',
        (col.numeric || right) && 'tabular',
        selected && 'outline outline-2 -outline-offset-2 outline-accent',
      )}
      style={{ width: col.width }}
    >
      <span className="flex max-w-full items-center gap-1.5">
        {Icon && <Icon size={13} aria-label={STATUS_TAG[field.status]} className={cn('shrink-0', TAG_TEXT[field.status])} />}
        {field.status === 'suggested' && <span className={cn('shrink-0 text-xs font-semibold', TAG_TEXT.suggested)}>AI</span>}
        <span className="truncate">{value || <span className="text-muted">празно</span>}</span>
      </span>
      {en && <span className="block max-w-full truncate text-[11px] text-ink-2">EN · {en}</span>}
    </button>
  )
}

function imageLabel(field: FieldRecord): string {
  const src = field.sources.find((s) => s.height)
  if (src?.height) return `${src.height} px`
  return display(field.value) ? 'има' : ''
}
