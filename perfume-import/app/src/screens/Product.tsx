import { ImageOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { FieldPanel } from '../components/FieldPanel'
import { Failure, Loading } from '../components/States'
import { StatusMark } from '../components/StatusMark'
import { BAR, TAG_TEXT, TINT } from '../lib/status'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Batch, type FieldRecord, type PricePlan, type Product, type StoreInfo } from '../lib/api'
import { cn } from '../lib/cn'
import { fromEur, toEur } from '../lib/money'
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
import { useAcceptAll, useApprove, useBatch, useDecide, useUploadState } from '../lib/queries'

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
            <div className="flex min-w-0 grow flex-col gap-6">
              <PricesSection batch={batch.data} product={product} />
              <FieldsTable batch={batch.data} product={product} open={open} onOpen={setOpen} />
            </div>
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
    <nav
      aria-label="Продукти"
      className="flex w-[240px] shrink-0 flex-col border-r border-line bg-surface xl:w-[300px]"
    >
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
  const approvedInBatch = batch.products.filter((p) => Object.values(p.stores).every((s) => s.approved_at)).length
  const pendingInBatch = batch.products
    .flatMap(allFields)
    .filter((f) => f.status === 'suggested' || f.status === 'blocked').length
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
            {[display(first.vendor?.value), display(first.sku?.value), tester ? 'тестер' : '']
              .filter(Boolean)
              .join(' · ')}
          </div>
          <h1 className="m-0 line-clamp-2 text-[24px] font-semibold leading-tight">{product.title}</h1>
        </div>
        {pendingInBatch > 0 && (
          <Button size="lg" asChild>
            <Link to={`/batches/${batch.id}/queue`}>Реши чакащите в партидата ({pendingInBatch})</Link>
          </Button>
        )}
        {approvedInBatch > 0 && (
          <Button size="lg" asChild>
            <Link to={`/batches/${batch.id}/upload`}>Качи {plural(approvedInBatch, 'одобрен', 'одобрени')}</Link>
          </Button>
        )}
        <Button
          size="lg"
          disabled={!suggested || acceptAll.isPending}
          onClick={() => acceptAll.mutate({ productId: product.id })}
        >
          {suggested
            ? `Приеми ${suggested === 1 ? 'предложението' : `всички ${suggested} предложения`}`
            : 'Няма предложения'}
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
      {approved && approvedBy && (
        <div className="text-xs text-ok">Одобрен от {approvedBy}. Всяка промяна по продукта сваля одобрението.</div>
      )}
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
    return {
      main: main.filter((k) => present.has(k)),
      rest: [...new Set(rest)].filter((k) => present.has(k)),
    }
  }, [product])
  const shown = all ? [...keys.main, ...keys.rest] : keys.main
  const cols = `150px repeat(${stores.length}, minmax(0, 1fr))`

  return (
    <section className="flex min-w-0 shrink-0 grow flex-col overflow-hidden rounded-lg border border-line">
      <div
        className="grid border-b border-line bg-surface text-xs font-semibold text-ink-3"
        style={{ gridTemplateColumns: cols }}
      >
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
        <div
          key={key}
          className="grid border-b border-line-2 text-sm last:border-b-0"
          style={{ gridTemplateColumns: cols }}
        >
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
          {all
            ? 'Скрий останалите полета'
            : `Покажи останалите ${keys.rest.length} полета (заглавие, SKU, фиксирани колони)`}
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

function StorePicker({
  stores,
  value,
  onChange,
}: {
  stores: StoreInfo[]
  value: string
  onChange: (k: string) => void
}) {
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
      {field.status === 'ok' && field.decided_by && (
        <span className="text-[11px] font-semibold text-ok">решено от {field.decided_by}</span>
      )}
      <span
        className={cn(
          'max-w-full leading-normal',
          text && 'line-clamp-3',
          ['price', 'compare_at'].includes(field.key) && 'tabular',
        )}
      >
        {value || <span className="text-ink-2">празно</span>}
      </span>
      {en && <span className="line-clamp-2 max-w-full text-xs leading-normal text-ink-2">EN · {en}</span>}
    </button>
  )
}

/** Every store of the batch: whether it can be published to (template + Shopify access), and its price and
 * compare-at price, editable here (decisions #16: without a price the product goes up only as a draft). */
function PricesSection({ batch, product }: { batch: Batch; product: Product }) {
  const client = useQueryClient()
  const upload = useUploadState(batch.id)
  const [status, setStatus] = useState<'draft' | 'active'>('draft')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const running = !!upload.data?.running
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) void client.invalidateQueries({ queryKey: ['batch', batch.id] })
    wasRunning.current = running
  }, [running, client, batch.id])

  const fx = useQuery({
    queryKey: ['fx'],
    queryFn: api.fx,
    staleTime: 3600_000,
  })
  const [plan, setPlan] = useState<PricePlan | null>(null)
  const ready = batch.stores.filter((s) => product.stores[s.key] && publishable(s, product.stores[s.key].fields))
  const publish = async (stores: string[]) => {
    setBusy(true)
    setNote(null)
    try {
      const r = await api.publish(product.id, stores, status)
      const skipped = Object.entries(r.skipped)
      setNote(
        `Качва се в ${r.stores.length} ${r.stores.length === 1 ? 'магазин' : 'магазина'}` +
          (status === 'active' ? ' (където няма цена: като чернова).' : ' като чернова.') +
          (skipped.length ? ` Пропуснати: ${skipped.map(([k, v]) => `${k} (${v})`).join('; ')}.` : ''),
      )
      await upload.refetch()
    } catch (e) {
      setNote((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Цени и магазини">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 grow text-base font-semibold">Цени и магазини</h2>
        {batch.kind === 'new' && (
          <>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={`status-${product.id}`}
                checked={status === 'draft'}
                onChange={() => setStatus('draft')}
              />
              като чернова
            </label>
            <label className="flex items-center gap-1.5 text-sm" title="Магазин без цена се качва като чернова">
              <input
                type="radio"
                name={`status-${product.id}`}
                checked={status === 'active'}
                onChange={() => setStatus('active')}
              />
              активен
            </label>
            <Button
              size="sm"
              variant="primary"
              disabled={!ready.length || running || busy}
              onClick={() => void publish(ready.map((s) => s.key))}
            >
              {running
                ? `Качва се… ${upload.data?.done ?? 0}/${upload.data?.total ?? 0}`
                : `Публикувай във всички готови (${ready.length})`}
            </Button>
          </>
        )}
        <AddStores batch={batch} />
      </div>
      <EuroPrices productId={product.id} batchId={batch.id} plan={plan} onPlan={setPlan} />
      {note && <div className="text-sm leading-normal text-ink-3">{note}</div>}
      <div className="flex flex-col rounded-lg border border-line" role="table">
        <div
          role="row"
          className="grid grid-cols-[minmax(0,1.3fr)_110px_110px_minmax(0,1fr)_80px_110px] gap-3 border-b border-line bg-surface px-4 py-2 text-xs font-medium text-ink-2"
        >
          <span role="columnheader">Магазин</span>
          <span role="columnheader">Цена</span>
          <span role="columnheader">Зачеркната</span>
          <span role="columnheader">Състояние</span>
          <span role="columnheader" />
          <span role="columnheader" />
        </div>
        {batch.stores.map((s) =>
          product.stores[s.key] ? (
            <PriceRow
              rates={fx.data?.rates}
              planned={plan?.stores[s.key]}
              canPublish={batch.kind === 'new'}
              busy={running || busy}
              onPublish={() => void publish([s.key])}
              key={`${product.id}-${s.key}-${display(product.stores[s.key].fields.price?.value)}-${display(product.stores[s.key].fields.compare_at?.value)}-${plan?.date ?? ''}-${plan?.stores[s.key]?.price ?? ''}-${fx.data ? 'fx' : ''}`}
              batch={batch}
              product={product}
              store={s}
            />
          ) : null,
        )}
      </div>
    </section>
  )
}

function PriceRow({
  batch,
  product,
  store,
  canPublish,
  busy,
  onPublish,
  rates,
  planned,
}: {
  batch: Batch
  product: Product
  store: StoreInfo
  rates?: Record<string, number>
  planned?: PricePlan['stores'][string]
  canPublish: boolean
  busy: boolean
  onPublish: () => void
}) {
  const sp = product.stores[store.key]
  const fields = sp.fields
  const price = fields.price
  const compare = fields.compare_at
  const currency = store.currency ?? '?'
  const initial = { price: money(price?.value), compare: money(compare?.value) }
  const foreign = currency !== 'EUR' && !!rates?.[currency]
  // Outside the euro the row takes euros and saves the store's own amount (shown under the field); „в Kč“ switches
  // to typing the local amount. A price from the euro calculator above is shown as it is, in the local currency.
  const [eurMode, setEurMode] = useState(foreign && !planned?.price)
  const startLocal = planned?.price ? { price: planned.price, compare: planned.compare_at ?? '' } : initial
  const [draft, setDraft] = useState(
    eurMode
      ? { price: toEur(startLocal.price, currency, rates), compare: toEur(startLocal.compare, currency, rates) }
      : startLocal,
  )
  const local = eurMode
    ? {
        price: fromEur(draft.price, currency, rates, store.price_cents),
        compare: fromEur(draft.compare, currency, rates, store.price_cents),
      }
    : draft
  const decide = useDecide(batch.id)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed =
    local.price !== null &&
    local.compare !== null &&
    (eurMode
      ? toEur(local.price, currency, rates) !== toEur(initial.price, currency, rates) ||
        toEur(local.compare, currency, rates) !== toEur(initial.compare, currency, rates)
      : local.price !== initial.price || local.compare !== initial.compare)
  const ready = store.template && !store.access
  const pending = pendingText(fields)
  const why = !store.template
    ? 'няма шаблон: качи каталога му в „Магазини“'
    : (shortReason(store.access) ?? (pending ? `${pending}: реши ги в таблицата долу` : null))
  const issue = [price, compare].find((f) => f && f.status !== 'ok' && f.message)

  const switchMode = () => {
    if (eurMode) setDraft({ price: local.price ?? '', compare: local.compare ?? '' })
    else setDraft({ price: toEur(draft.price, currency, rates), compare: toEur(draft.compare, currency, rates) })
    setEurMode(!eurMode)
  }

  const save = async () => {
    if (local.price === null || local.compare === null) return
    setSaving(true)
    setError(null)
    try {
      const next = { price: local.price.replace(',', '.'), compare: local.compare.replace(',', '.') }
      if (price && next.price !== initial.price)
        await decide.mutateAsync({ fieldId: price.id, action: 'edit', value: next.price })
      if (compare && next.compare !== initial.compare)
        await decide.mutateAsync({ fieldId: compare.id, action: 'edit', value: next.compare })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const hint = (entered: string, saved: string | null) => {
    if (!entered.trim()) return ' '
    if (saved === null) return 'невалидна сума'
    if (eurMode) return `€ → ${saved} ${currency}`
    const eur = toEur(saved, currency, rates)
    return currency !== 'EUR' && eur ? `${currency} · ≈ €${eur}` : currency
  }
  const input = 'tabular h-8 w-full rounded-md border border-line bg-canvas px-2 text-sm'
  return (
    <form
      role="row"
      className="grid grid-cols-[minmax(0,1.3fr)_110px_110px_minmax(0,1fr)_80px_110px] items-center gap-3 border-b border-line-2 px-4 py-2 text-sm last:border-b-0"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <span
        role="cell"
        className="flex min-w-0 flex-col gap-0.5"
        title={ready ? 'Може да се публикува' : (why ?? undefined)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              'size-2.5 shrink-0 rounded-full',
              ready ? 'bg-ok' : store.template ? 'bg-warning' : 'bg-line',
            )}
          />
          <span className="truncate">
            {store.label} · {storeShort(store)} · {currency}
          </span>
        </span>
        {foreign && (
          <button
            type="button"
            onClick={switchMode}
            className="ml-[18px] self-start border-0 bg-transparent p-0 text-[11px] text-accent hover:underline"
          >
            {eurMode ? `въведи в ${currency}` : 'въведи в EUR'}
          </button>
        )}
      </span>
      <span role="cell" className="flex flex-col gap-0.5">
        <input
          aria-label={`Цена ${store.label} (${eurMode ? 'EUR' : currency})`}
          inputMode="decimal"
          placeholder={eurMode ? 'цена в €' : 'без цена'}
          value={draft.price}
          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
          className={input}
        />
        <span className={cn('tabular text-[11px]', eurMode ? 'text-ink-3' : 'text-ink-2')}>
          {draft.price.trim() ? hint(draft.price, local.price) : eurMode ? '€' : currency}
        </span>
      </span>
      <span role="cell" className="flex flex-col gap-0.5">
        <input
          aria-label={`Зачеркната цена ${store.label} (${eurMode ? 'EUR' : currency})`}
          inputMode="decimal"
          placeholder="—"
          value={draft.compare}
          onChange={(e) => setDraft({ ...draft, compare: e.target.value })}
          className={input}
        />
        <span className="tabular text-[11px] text-ink-2">{hint(draft.compare, local.compare)}</span>
      </span>
      <span role="cell" className="min-w-0 text-xs leading-snug">
        {error ? (
          <span className="text-blocked-text">{error}</span>
        ) : sp.upload_status ? (
          <span className={sp.upload_status === 'uploaded' ? 'text-ok' : 'text-blocked-text'}>
            {sp.upload_status === 'uploaded' ? 'качен: ' : 'грешка: '}
            {sp.upload_message}
          </span>
        ) : !ready || pending ? (
          <span className="text-ink-2">{why}</span>
        ) : issue ? (
          <span className={TAG_TEXT[issue.status]}>{issue.message}</span>
        ) : (
          <span className="text-ok">може да се публикува</span>
        )}
      </span>
      <span role="cell" className="flex justify-end">
        <Button type="submit" size="sm" disabled={!changed || saving}>
          Запази
        </Button>
      </span>
      <span role="cell" className="flex justify-end">
        {canPublish && (
          <Button
            type="button"
            size="sm"
            variant={sp.upload_status === 'uploaded' ? 'secondary' : 'primary'}
            disabled={busy || changed || !publishable(store, fields)}
            title={publishable(store, fields) ? undefined : (why ?? undefined)}
            onClick={onPublish}
          >
            {sp.upload_status === 'uploaded' ? 'Обнови' : 'Публикувай'}
          </Button>
        )}
      </span>
    </form>
  )
}

function money(value: unknown): string {
  const text = display(value)
  return text === 'None' ? '' : text
}

/** The upload blocker in a few words; the full message is in Магазини → the store. */
function shortReason(access: string | null | undefined): string | null {
  if (!access) return null
  if (access.includes('домейн')) return 'няма Shopify адрес (Магазини → магазина)'
  if (access.includes('достъп')) return 'няма Shopify ключове (Магазини → магазина)'
  return access
}

/** More stores of the group for the whole batch: research is reused, only texts and pictures are made. */
function AddStores({ batch }: { batch: Batch }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const options = useQuery({
    queryKey: ['store-options', batch.id],
    queryFn: () => api.storeOptions(batch.id),
    enabled: open,
  })
  if (batch.kind !== 'new') return null
  const cost = options.data ? options.data.cost_per_text * (1 + picked.length) : 0

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const r = await api.addStores(batch.id, picked, true)
      navigate(`/batches/new?job=${r.job_id}`)
    } catch (e) {
      setError((e as Error).message)
      setStarting(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Добави магазини
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Добави магазини към партидата"
        description="Проучването се използва наново, без да се плаща. Всеки нов магазин получава своята снимка, свой текст по шаблона си и полетата си. Решенията ти за EAN, марка, пол и т.н. се пренасят."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Откажи</Button>
            <Button variant="primary" disabled={!picked.length || starting} onClick={() => void start()}>
              {picked.length ? `Добави ${picked.length} за ≈ $${cost.toFixed(2)}` : 'Добави'}
            </Button>
          </>
        }
      >
        {options.isPending ? (
          <Loading what="магазините" />
        ) : options.isError ? (
          <Failure error={options.error} />
        ) : !options.data.stores.length ? (
          <span className="text-sm text-ink-2">Всички магазини от групата вече са в партидата.</span>
        ) : (
          <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
            {options.data.stores.map((s) => {
              const ready = s.template && !s.access
              return (
                <label key={s.key} className="flex items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.includes(s.key)}
                    onChange={(e) =>
                      setPicked(e.target.checked ? [...picked, s.key] : picked.filter((k) => k !== s.key))
                    }
                  />
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2.5 shrink-0 rounded-full',
                      ready ? 'bg-ok' : s.template ? 'bg-warning' : 'bg-line',
                    )}
                  />
                  <span className="flex flex-col">
                    {s.label} · {languageName(s.language)}
                    <span className="text-xs text-ink-2">
                      {!s.template
                        ? 'без шаблон: текстът е общ превод на езика, заглавието по формулата на групата'
                        : s.access
                          ? `шаблон ✓ · ${shortReason(s.access)}`
                          : 'шаблон ✓ · може да се публикува'}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
        )}
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </Dialog>
    </>
  )
}

/** A store can be published to: template, Shopify access, and no blocked field or open suggestion in it. */
function publishable(store: StoreInfo, fields: Record<string, FieldRecord>): boolean {
  return !!store.template && !store.access && !pendingText(fields)
}

function pendingText(fields: Record<string, FieldRecord>): string | null {
  const all = Object.values(fields)
  const blocked = all.filter((f) => f.status === 'blocked').length
  const suggested = all.filter((f) => f.status === 'suggested').length
  const parts = [blocked && `${blocked} спрени`, suggested && `${suggested} предложения`].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

/** One price in euros → every store's price (ECB rate, the store's rounding), shown in the rows to check;
 * „Запази всички“ saves them at once. */
function EuroPrices({
  productId,
  batchId,
  plan,
  onPlan,
}: {
  productId: number
  batchId: number
  plan: PricePlan | null
  onPlan: (p: PricePlan | null) => void
}) {
  const client = useQueryClient()
  const [price, setPrice] = useState('')
  const [compare, setCompare] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const number = (v: string) => Number(v.replace(',', '.'))

  const calculate = async () => {
    setBusy(true)
    setError(null)
    try {
      onPlan(await api.pricePlan(productId, number(price), compare ? number(compare) : null))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const saveAll = async () => {
    if (!plan) return
    setBusy(true)
    setError(null)
    try {
      const stores = Object.fromEntries(
        Object.entries(plan.stores)
          .filter(([, v]) => v.price)
          .map(([k, v]) => [k, { price: v.price ?? '', compare_at: v.compare_at ?? '' }]),
      )
      const updated = await api.setPrices(productId, stores)
      client.setQueryData<Batch>(['batch', batchId], (old) =>
        old
          ? {
              ...old,
              products: old.products.map((p) => (p.id === updated.id ? updated : p)),
            }
          : old,
      )
      onPlan(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = 'tabular h-8 w-[100px] rounded-md border border-line bg-canvas px-2 text-sm'
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm">
      <span className="font-medium">Цена в EUR</span>
      <input
        inputMode="decimal"
        placeholder="74"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className={input}
      />
      <span className="text-ink-2">зачеркната</span>
      <input
        inputMode="decimal"
        placeholder="119"
        value={compare}
        onChange={(e) => setCompare(e.target.value)}
        className={input}
      />
      <Button size="sm" disabled={!(number(price) > 0) || busy} onClick={() => void calculate()}>
        Изчисли за всички магазини
      </Button>
      {plan && (
        <>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveAll()}>
            Запази всички
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onPlan(null)}>
            Откажи
          </Button>
          <span className="basis-full text-xs text-ink-2">
            По курса на ЕЦБ от {plan.date ?? '—'}, закръглено както магазинът пише цените си. Провери редовете и запази.
          </span>
        </>
      )}
      {error && <span className="basis-full text-xs text-blocked-text">{error}</span>}
    </div>
  )
}
