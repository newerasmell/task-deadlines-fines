import { ImageOff } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { FieldPanel } from '../components/FieldPanel'
import { Failure, Loading } from '../components/States'
import { BAR, StatusMark, TAG_TEXT, TINT } from '../components/StatusMark'
import { Button } from '../components/ui/button'
import type { Batch, FieldRecord, Product, StoreInfo } from '../lib/api'
import { cn } from '../lib/cn'
import {
  allFields,
  display,
  fieldLabel,
  groupLabel,
  host,
  IDENTITY_FIELDS,
  languageName,
  LOCALIZED,
  plural,
  productNote,
  REVIEW_FIELDS,
  shortDate,
  STATUS_TAG,
  storeShort,
  stripHtml,
} from '../lib/labels'
import { useAcceptAll, useApprove, useBatch } from '../lib/queries'

// Main review screen (Product.dc.html): product list, the finished picture, every store side by side.

type Open = { store: string; key: string } | null

export function ProductScreen() {
  const params = useParams()
  const batchId = Number(params.batchId)
  const productId = Number(params.productId)
  const batch = useBatch(batchId)
  const [open, setOpen] = useState<Open>(null)

  if (batch.isPending) return <Loading what="партидата" />
  if (batch.isError) return <Failure error={batch.error} retry={() => batch.refetch()} />
  const product = batch.data.products.find((p) => p.id === productId)
  if (!product) return <Failure error={new Error(`Продукт ${productId} не е в тази партида.`)} />

  return (
    <div className="flex h-screen min-w-[1024px] bg-canvas">
      <ProductList batch={batch.data} current={product.id} />
      <main className="flex min-w-0 grow flex-col">
        <ProductHeader batch={batch.data} product={product} />
        <div className="flex min-h-0 grow">
          <div className="flex min-h-0 min-w-0 grow flex-col gap-6 overflow-y-auto px-7 py-6 xl:flex-row xl:items-start xl:gap-7">
            {!open && <ImageSection product={product} onOpen={(store) => setOpen({ store, key: 'image' })} />}
            <FieldsTable batch={batch.data} product={product} open={open} onOpen={setOpen} />
          </div>
          {open && (
            <FieldPanel
              key={`${product.id}-${open.store}-${open.key}`}
              batch={batch.data}
              product={product}
              store={open.store}
              fieldKey={open.key}
              onClose={() => setOpen(null)}
            />
          )}
        </div>
      </main>
    </div>
  )
}

function ProductList({ batch, current }: { batch: Batch; current: number }) {
  const stores = batch.stores.map(storeShort).join(' и ')
  return (
    <nav aria-label="Продукти" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-surface xl:w-[300px]">
      <div className="flex flex-col gap-1 border-b border-line px-5 pb-3.5 pt-[18px]">
        <Link to="/" className="text-sm text-ink-2 no-underline hover:text-ink">
          Партиди
        </Link>
        <div className="text-md font-semibold">
          {shortDate(batch.created_at)}, {groupLabel(batch.group)}
        </div>
        <div className="text-xs text-ink-2">
          {plural(batch.products.length, 'продукт', 'продукта')} · {plural(batch.stores.length, 'сайт', 'сайта')}
          {batch.stores.length > 1 ? `, сравнение ${stores}` : ''}
        </div>
        <Link to={`/batches/${batch.id}/grid`} className="mt-1 text-sm no-underline">
          Таблица на партидата
        </Link>
      </div>
      <div className="overflow-y-auto">
        {batch.products.map((p) => {
          const note = productNote(p)
          const active = p.id === current
          return (
            <Link
              key={p.id}
              to={`/batches/${batch.id}/products/${p.id}`}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex w-full items-start gap-2.5 px-5 py-2.5 text-left no-underline',
                active ? 'bg-canvas shadow-[inset_3px_0_0_var(--color-ink)]' : 'hover:bg-well',
              )}
            >
              <StatusMark status={note.status} className="mt-[5px]" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-ink">{p.title}</span>
                <span className={cn('text-xs', note.status === 'ok' ? 'text-ink-2' : TAG_TEXT[note.status])}>
                  {note.text}
                </span>
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

function ProductHeader({ batch, product }: { batch: Batch; product: Product }) {
  const acceptAll = useAcceptAll(batch.id)
  const approve = useApprove(batch.id)
  const fields = allFields(product)
  const suggested = fields.filter((f) => f.status === 'suggested').length
  const blocked = fields.filter((f) => f.status === 'blocked').length
  const pendingInBatch = batch.products.flatMap(allFields).filter((f) => f.status === 'suggested' || f.status === 'blocked').length
  const first = Object.values(product.stores)[0]?.fields ?? {}
  const approved = Object.values(product.stores).every((s) => s.approved_at)
  const approvedBy = Object.values(product.stores)[0]?.approved_by
  const tester = /\bTESTER\b/i.test(display(first.title?.value))
  const error = (acceptAll.error ?? approve.error) as Error | null

  return (
    <header className="flex flex-col gap-2 border-b border-line px-7 py-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 grow basis-full flex-col gap-1 2xl:basis-0">
          <div className="text-sm text-ink-2">
            {[display(first.vendor?.value), display(first.sku?.value), tester ? 'тестер' : ''].filter(Boolean).join(' · ')}
          </div>
          <h1 className="m-0 line-clamp-2 text-[24px] font-semibold leading-tight">{product.title}</h1>
        </div>
        {pendingInBatch > 0 && (
          <Button size="lg" asChild>
            <Link to={`/batches/${batch.id}/queue`}>Реши чакащите в партидата ({pendingInBatch})</Link>
          </Button>
        )}
        <Button
          size="lg"
          disabled={!suggested || acceptAll.isPending}
          onClick={() => acceptAll.mutate({ productId: product.id })}
        >
          {suggested ? `Приеми ${suggested === 1 ? 'предложението' : `всички ${suggested} предложения`}` : 'Няма предложения'}
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={approved || !!suggested || !!blocked || approve.isPending}
          title={
            blocked
              ? `${blocked} спрени полета трябва да се поправят преди одобрение`
              : suggested
                ? 'Първо реши предложенията'
                : undefined
          }
          onClick={() => approve.mutate(product.id)}
        >
          {approved ? 'Одобрен' : 'Одобри продукта'}
        </Button>
      </div>
      {approved && approvedBy && <div className="text-xs text-ok">Одобрен от {approvedBy}. Всяка промяна по продукта сваля одобрението.</div>}
      {error && <div className="text-sm text-blocked-text">{error.message}</div>}
    </header>
  )
}

function ImageSection({ product, onOpen }: { product: Product; onOpen: (store: string) => void }) {
  const [store, image] = Object.entries(product.stores).map(([k, s]) => [k, s.fields.image] as const)[0] ?? []
  const original = product.media.find((m) => m.kind === 'original')
  const composed = product.media.find((m) => m.kind === 'composed' && image && image.value === m.url)
  const url = image ? display(image.value) : ''
  const warnings = composed?.info.warnings ?? []

  return (
    <section className="grid shrink-0 grid-cols-[180px_minmax(0,1fr)] gap-x-5 gap-y-3 xl:flex xl:w-[300px] xl:flex-col">
      <h2 className="col-span-2 m-0 text-base font-semibold">Основна снимка</h2>
      <button
        onClick={() => store && onOpen(store)}
        className={cn(
          'row-span-2 flex h-[180px] items-center justify-center overflow-hidden rounded-md border border-line bg-well p-0 xl:h-[300px]',
          image && image.status !== 'ok' && BAR[image.status],
        )}
        aria-label="Детайли за снимката"
      >
        {url.startsWith('/api/media/') || url.startsWith('http') ? (
          <img src={url} alt={product.title} className="h-full w-full bg-canvas object-contain" />
        ) : (
          <span className="flex flex-col items-center gap-2.5 text-xs text-ink-2">
            <ImageOff size={16} />
            {image?.message ?? 'Няма снимка'}
          </span>
        )}
      </button>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col gap-0.5 rounded-md border border-line p-2.5">
          <span className="text-ink-2">Оригинал</span>
          <span className="tabular font-medium">{original ? `${original.width} × ${original.height}` : '—'}</span>
          {original?.source_url && (
            <a href={original.source_url} target="_blank" rel="noreferrer" className="truncate">
              {host(original.source_url)}
            </a>
          )}
        </div>
        <div className="flex flex-col gap-0.5 rounded-md border border-line p-2.5">
          <span className="text-ink-2">Резултат</span>
          <span className="tabular font-medium">{composed ? `${composed.width} × ${composed.height}` : '—'}</span>
          {composed && (
            <span className={warnings.length ? 'text-warning-text' : 'text-ok'}>
              {composed.info.scaled != null && composed.info.scaled < 1
                ? `смалено до ${Math.round(composed.info.scaled * 100)}%`
                : 'без увеличаване'}
            </span>
          )}
        </div>
      </div>
      {image && image.status !== 'ok' && image.message && (
        <div className={cn('text-xs leading-normal', TAG_TEXT[image.status])}>{image.message}</div>
      )}
    </section>
  )
}

function FieldsTable({
  batch,
  product,
  open,
  onOpen,
}: {
  batch: Batch
  product: Product
  open: Open
  onOpen: (o: Open) => void
}) {
  const [all, setAll] = useState(false)
  const [pair, setPair] = useState<string[]>(() => batch.stores.slice(0, 2).map((s) => s.key))
  const stores = pair.map((k) => batch.stores.find((s) => s.key === k)!).filter(Boolean)

  const keys = useMemo(() => {
    const present = new Set(Object.values(product.stores).flatMap((s) => Object.keys(s.fields)))
    const pending = [...present].filter((k) =>
      Object.values(product.stores).some((s) => s.fields[k] && s.fields[k].status !== 'ok'),
    )
    const main = [...REVIEW_FIELDS, ...pending.filter((k) => !REVIEW_FIELDS.includes(k) && k !== 'image')]
    const rest = [...IDENTITY_FIELDS, ...[...present].sort()].filter((k) => !main.includes(k) && k !== 'image')
    return { main: main.filter((k) => present.has(k)), rest: [...new Set(rest)].filter((k) => present.has(k)) }
  }, [product])
  const shown = all ? [...keys.main, ...keys.rest] : keys.main
  const cols = `150px repeat(${stores.length}, minmax(0, 1fr))`

  return (
    <section className="flex min-w-0 grow flex-col overflow-hidden rounded-lg border border-line">
      <div className="grid border-b border-line bg-surface text-xs font-semibold text-ink-3" style={{ gridTemplateColumns: cols }}>
        <div className="px-3.5 py-2.5">Поле</div>
        {stores.map((s, i) => (
          <div key={s.key} className="border-l border-line px-3.5 py-2.5">
            {batch.stores.length > 2 ? (
              <StorePicker
                stores={batch.stores}
                value={s.key}
                onChange={(k) => setPair(pair.map((p, j) => (j === i ? k : p)))}
              />
            ) : (
              <StoreHeading store={s} />
            )}
          </div>
        ))}
      </div>
      {shown.map((key) => (
        <div key={key} className="grid border-b border-line-2 text-sm last:border-b-0" style={{ gridTemplateColumns: cols }}>
          <div className="px-3.5 py-[11px] text-ink-2">{fieldLabel(key)}</div>
          {stores.map((s) => {
            const f = product.stores[s.key]?.fields[key]
            return (
              <Cell
                key={s.key}
                field={f}
                selected={open?.store === s.key && open?.key === key}
                onClick={() => f && onOpen({ store: s.key, key })}
              />
            )
          })}
        </div>
      ))}
      {keys.rest.length > 0 && (
        <button
          onClick={() => setAll(!all)}
          className="border-0 border-t border-line-2 bg-canvas px-3.5 py-2.5 text-left text-sm text-accent hover:bg-surface"
        >
          {all ? 'Скрий останалите полета' : `Покажи останалите ${keys.rest.length} полета (заглавие, SKU, фиксирани колони)`}
        </button>
      )}
    </section>
  )
}

function StoreHeading({ store }: { store: StoreInfo }) {
  return (
    <>
      {store.label} · {storeShort(store)} · {languageName(store.language)}
    </>
  )
}

function StorePicker({ stores, value, onChange }: { stores: StoreInfo[]; value: string; onChange: (k: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-full border-0 bg-transparent p-0 text-xs font-semibold text-ink-3"
      aria-label="Сайт за сравнение"
    >
      {stores.map((s) => (
        <option key={s.key} value={s.key}>
          {s.label} · {storeShort(s)} · {languageName(s.language)}
        </option>
      ))}
    </select>
  )
}

function Cell({ field, selected, onClick }: { field?: FieldRecord; selected: boolean; onClick: () => void }) {
  if (!field) return <div className="border-l border-line-2 px-3.5 py-[11px] text-ink-2">—</div>
  const text = field.key === 'body_html' || field.key === 'seo_description'
  const value = text ? stripHtml(field.value) : display(field.value)
  const en = LOCALIZED.has(field.key) && field.value_en ? (text ? stripHtml(field.value_en) : field.value_en) : ''
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col items-start gap-[3px] border-0 border-l border-line-2 px-3.5 py-[11px] text-left text-sm text-ink',
        TINT[field.status],
        BAR[field.status],
        selected ? 'outline outline-2 -outline-offset-2 outline-accent' : 'hover:brightness-[0.98]',
      )}
    >
      {field.status !== 'ok' && (
        <span className={cn('line-clamp-2 text-[11px] font-semibold', TAG_TEXT[field.status])}>
          {STATUS_TAG[field.status]}
          {field.status === 'blocked' || field.status === 'warning' ? `: ${field.message ?? ''}` : ''}
        </span>
      )}
      {field.status === 'ok' && field.decided_by && <span className="text-[11px] font-semibold text-ok">решено от {field.decided_by}</span>}
      <span className={cn('max-w-full leading-normal', text && 'line-clamp-3', ['price', 'compare_at'].includes(field.key) && 'tabular')}>
        {value || <span className="text-ink-2">празно</span>}
      </span>
      {en && <span className="line-clamp-2 max-w-full text-xs leading-normal text-ink-2">EN · {en}</span>}
    </button>
  )
}
