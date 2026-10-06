import { ImageOff } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Empty, Failure, Loading } from '../components/States'
import { StatusMark } from '../components/StatusMark'
import { TAG_TEXT } from '../lib/status'
import { Button } from '../components/ui/button'
import type { Batch, FieldRecord, Product, Status } from '../lib/api'
import { cn } from '../lib/cn'
import { display, fieldLabel, groupLabel, host, shortDate, storeShort, stripHtml } from '../lib/labels'
import { useBatch, useDecide } from '../lib/queries'

// "Resolve pending" mode (Queue.dc.html): one decision at a time, grouped by what blocks the batch most.

const SHARED = new Set(['vendor', 'name', 'concentration', 'gender', 'fragrance_family', 'ingredients', 'ean', 'sku', 'image'])
const GROUPS: { status: Status; title: string }[] = [
  { status: 'blocked', title: 'Спрени' },
  { status: 'suggested', title: 'AI предложения' },
  { status: 'warning', title: 'Предупреждения' },
]

type Item = { id: string; productId: number; key: string; stores: string[]; status: Status }

const QUESTIONS: Record<string, string> = {
  fragrance_family: 'Кое семейство е правилното?',
  gender: 'Кой е полът?',
  top_note: 'Верни ли са горните нотки?',
  middle_note: 'Верни ли са средните нотки?',
  base_note: 'Верни ли са базовите нотки?',
  body_html: 'Одобряваш ли описанието?',
  seo_description: 'Одобряваш ли SEO описанието?',
  image: 'Тази снимка ли да отиде в магазина?',
  ean: 'Кой EAN е верният?',
  compare_at: 'Каква да е зачеркнатата цена?',
  price: 'Каква да е цената?',
  title: 'Вярно ли е заглавието?',
}

function itemsOf(batch: Batch): Item[] {
  const out: Item[] = []
  for (const p of batch.products) {
    const seen = new Set<string>()
    for (const [store, sp] of Object.entries(p.stores)) {
      for (const f of Object.values(sp.fields)) {
        if (!['blocked', 'suggested', 'warning'].includes(f.status)) continue
        if (SHARED.has(f.key)) {
          // One decision for every store where the shared fact has the same value.
          const id = `${p.id}:${f.key}:${display(f.value)}`
          if (seen.has(id)) continue
          seen.add(id)
          const stores = Object.entries(p.stores)
            .filter(([, s]) => s.fields[f.key] && display(s.fields[f.key].value) === display(f.value))
            .map(([k]) => k)
          out.push({ id, productId: p.id, key: f.key, stores, status: f.status })
        } else {
          out.push({ id: `${p.id}:${f.key}:${store}`, productId: p.id, key: f.key, stores: [store], status: f.status })
        }
      }
    }
  }
  const order: Record<string, number> = { blocked: 0, suggested: 1, warning: 2 }
  return out.sort((a, b) => order[a.status] - order[b.status])
}

const isPending = (f?: FieldRecord) => !!f && ['blocked', 'suggested', 'warning'].includes(f.status)

export function QueueScreen() {
  const batchId = Number(useParams().batchId)
  const batch = useBatch(batchId)
  if (batch.isPending) return <Loading what="партидата" />
  if (batch.isError) return <Failure error={batch.error} retry={() => batch.refetch()} />
  return <Queue batch={batch.data} />
}

function Queue({ batch }: { batch: Batch }) {
  // The list is fixed when the screen opens, so progress counts what was decided here.
  const [items] = useState(() => itemsOf(batch))
  const product = (id: number) => batch.products.find((p) => p.id === id)!
  const fieldOf = (it: Item) => product(it.productId).stores[it.stores[0]]?.fields[it.key]
  const resolved = (it: Item) => !isPending(fieldOf(it))
  const done = items.filter(resolved).length

  const [currentId, setCurrentId] = useState<string | null>(() => items[0]?.id ?? null)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const current = items.find((i) => i.id === currentId) ?? null

  const next = (from: Item | null, alsoSkip?: string) => {
    const skip = new Set(skipped)
    if (alsoSkip) skip.add(alsoSkip)
    const start = from ? items.indexOf(from) + 1 : 0
    const order = [...items.slice(start), ...items.slice(0, start)]
    const target = order.find((i) => !resolved(i) && !skip.has(i.id) && i.id !== from?.id) ?? order.find((i) => !resolved(i) && i.id !== from?.id)
    setCurrentId(target?.id ?? null)
  }

  return (
    <div className="flex h-screen min-w-[1024px] flex-col bg-surface">
      <header className="flex h-14 shrink-0 items-center gap-5 border-b border-line bg-canvas px-6">
        <div className="flex items-center gap-2 text-base">
          <Link to="/" className="text-ink-2 no-underline hover:text-ink">
            Партиди
          </Link>
          <span className="text-muted">/</span>
          <span className="font-semibold">
            {shortDate(batch.created_at)}, {groupLabel(batch.group)}
          </span>
        </div>
        <div className="ml-6 flex max-w-[520px] grow items-center gap-3">
          <div className="flex h-1.5 grow rounded-[3px] bg-line" aria-hidden>
            <div className="rounded-[3px] bg-ok" style={{ width: `${items.length ? (done / items.length) * 100 : 100}%` }} />
          </div>
          <span className="tabular whitespace-nowrap text-sm text-ink-2">
            {done} от {items.length} решени
          </span>
        </div>
        <div className="grow" />
        <Button asChild>
          <Link to={current ? `/batches/${batch.id}/products/${current.productId}` : `/batches/${batch.id}`}>
            Към изгледа по продукт
          </Link>
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        <nav aria-label="Решения" className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-r border-line bg-canvas xl:w-[340px]">
          {GROUPS.map((g) => {
            const list = items.filter((i) => i.status === g.status)
            if (!list.length) return null
            return (
              <div key={g.status} className="flex flex-col">
                <div className="flex items-center gap-2 px-5 pb-2 pt-4 text-sm font-semibold">
                  <StatusMark status={g.status} />
                  {g.title}
                  <span className="font-normal text-ink-2">{list.filter((i) => !resolved(i)).length}</span>
                </div>
                {list.map((it) => {
                  const active = it.id === currentId
                  const f = fieldOf(it)
                  const isDone = resolved(it)
                  return (
                    <button
                      key={it.id}
                      onClick={() => setCurrentId(it.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full flex-col items-start gap-0.5 border-0 px-5 py-2.5 text-left',
                        active ? 'bg-suggested-tint shadow-[inset_3px_0_0_var(--color-accent)]' : 'bg-canvas hover:bg-surface',
                      )}
                    >
                      <span className={cn('text-sm font-medium', isDone ? 'text-ink-2 line-through' : 'text-ink')}>
                        {itemTitle(it, f)} <span className="font-normal text-ink-2">· {scopeShort(batch, it)}</span>
                      </span>
                      <span className="max-w-full truncate text-xs text-ink-2">{product(it.productId).title}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>

        {current ? (
          <Decision
            key={current.id}
            batch={batch}
            item={current}
            product={product(current.productId)}
            onNext={() => next(current)}
            onSkip={() => {
              setSkipped(new Set([...skipped, current.id]))
              next(current, current.id)
            }}
          />
        ) : (
          <main className="flex grow flex-col items-start gap-4 px-10 py-8">
            <Empty>
              {items.length ? 'Всичко чакащо в партидата е решено.' : 'В партидата няма нищо за решаване.'}
            </Empty>
            <Button asChild>
              <Link to={`/batches/${batch.id}`}>Към продуктите за одобрение</Link>
            </Button>
          </main>
        )}
      </div>
    </div>
  )
}

function itemTitle(it: Item, f?: FieldRecord): string {
  if (it.key === 'compare_at' && f?.message) {
    const ratio = f.message.match(/(\d+(?:\.\d+)?)×/)?.[1]
    if (ratio) return `Зачеркната ${ratio.replace('.', ',')}× над цената`
  }
  if (it.key === 'price' && f?.status === 'blocked') return 'Липсва цена'
  if (it.key === 'ean' && f?.status === 'blocked') return 'EAN не минава проверката'
  if (it.key === 'ean' && f?.alternatives.length) return 'EAN за друг обем'

  if (it.key === 'image' && f) {
    const h = f.sources.find((s) => s.height)?.height
    return h ? `Снимка ${h} px` : 'Снимка'
  }
  return fieldLabel(it.key)
}

function scopeShort(batch: Batch, it: Item): string {
  if (it.stores.length > 1 && it.stores.length === batch.stores.length) return 'всички'
  return it.stores
    .map((k) => batch.stores.find((s) => s.key === k))
    .map((s) => (s ? storeShort(s) : ''))
    .join(', ')
}

type Option = { value: unknown; label: string; tag: string; tagClass: string; why: string; action: 'accept' | 'pick' | 'edit' }

function optionsFor(f: FieldRecord): Option[] {
  const opts: Option[] = []
  const show = (v: unknown) => (f.key === 'body_html' || f.key === 'seo_description' ? stripHtml(v) : display(v))
  const currentTag: Record<Status, string> = {
    ok: 'текуща',
    suggested: f.confidence != null ? `AI предложение · ${Math.round(f.confidence * 100)}%` : 'AI предложение',
    fixed: 'поправено',
    warning: 'внимание',
    blocked: 'спряно',
  }
  opts.push({
    value: f.value,
    label: show(f.value) || 'празно',
    tag: currentTag[f.status],
    tagClass: TAG_TEXT[f.status],
    why: f.message ?? '',
    action: 'accept',
  })
  for (const alt of f.alternatives) {
    if (display(alt) === display(f.value) || opts.length >= 3) continue
    opts.push({
      value: alt,
      label: show(alt),
      tag: 'алтернатива',
      tagClass: 'text-ink-2',
      why: f.key === 'ean' ? 'EAN, който източниците дават за този обем.' : 'Друга стойност от проучването или предишната.',
      action: 'pick',
    })
  }
  if (f.key === 'compare_at' && display(f.value) !== '' && opts.length < 3) {
    opts.push({ value: '', label: 'Без зачеркната цена', tag: 'бърза поправка', tagClass: 'text-ink-2', why: 'Продуктът се показва само с цената.', action: 'edit' })
  }
  return opts
}

function Decision({
  batch,
  item,
  product,
  onNext,
  onSkip,
}: {
  batch: Batch
  item: Item
  product: Product
  onNext: () => void
  onSkip: () => void
}) {
  const decide = useDecide(batch.id)
  const field = product.stores[item.stores[0]]?.fields[item.key]
  const options = useMemo(() => (field ? optionsFor(field) : []), [field])
  // A blocked value cannot be accepted, so the first option that can is preselected.
  const [choice, setChoice] = useState(() => (field?.status === 'blocked' && options.length > 1 ? 1 : 0))
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const chosen = options[choice]
  const blockedCurrent = field?.status === 'blocked' && chosen?.action === 'accept'

  const apply = () => {
    if (!field || !chosen || blockedCurrent) return
    decide.mutate(
      { fieldId: field.id, action: chosen.action, value: chosen.action === 'accept' ? undefined : chosen.value },
      { onSuccess: onNext },
    )
  }
  const saveTyped = () => field && draft.trim() && decide.mutate({ fieldId: field.id, action: 'edit', value: draft.trim() }, { onSuccess: onNext })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= options.length) {
        e.preventDefault()
        setChoice(n - 1)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        apply()
      } else if (['s', 'S', 'с', 'С'].includes(e.key)) {
        e.preventDefault()
        onSkip()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!field) return null
  const allStores = item.stores.length === batch.stores.length && batch.stores.length > 1
  const scope = allStores
    ? `всички сайтове в ${groupLabel(batch.group)}`
    : item.stores.map((k) => batch.stores.find((s) => s.key === k)).map((s) => (s ? `${s.label} ${storeShort(s)}` : '')).join(', ')
  const isImage = item.key === 'image'
  const text = item.key === 'body_html' || item.key === 'seo_description'
  const acceptLabel = blockedCurrent
    ? 'Избери друга стойност'
    : chosen?.action === 'edit'
      ? `${chosen.label}, продължи`
      : `Приеми ${isImage ? 'снимката' : text ? 'текста' : chosen?.label} и продължи`

  return (
    <>
      <main className="flex min-w-0 grow flex-col gap-6 overflow-y-auto px-10 py-8">
        <div className="flex flex-col gap-1">
          <div className="text-sm text-ink-2">
            {product.title} · {scope}
          </div>
          <h1 className="m-0 text-[28px] font-semibold leading-tight">{QUESTIONS[item.key] ?? `Какво да е полето „${fieldLabel(item.key)}“?`}</h1>
        </div>

        <div className={cn('grid gap-3', text ? 'grid-cols-1' : 'grid-cols-3')} role="radiogroup" aria-label="Варианти">
          {options.map((o, i) => (
            <button
              key={i}
              role="radio"
              aria-checked={i === choice}
              onClick={() => setChoice(i)}
              className={cn(
                'flex min-h-[150px] flex-col items-start gap-2.5 rounded-lg bg-canvas p-[18px] text-left',
                i === choice ? 'border-2 border-accent' : 'm-px border border-line',
              )}
            >
              <span className="flex w-full items-center justify-between">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded text-xs font-semibold',
                    i === choice ? 'bg-accent text-white' : 'bg-well text-ink-3',
                  )}
                >
                  {i + 1}
                </span>
                <span className={cn('text-xs font-medium', o.tagClass)}>{o.tag}</span>
              </span>
              {isImage && typeof o.value === 'string' && o.value ? (
                <img src={o.value} alt="" className="h-40 w-40 self-center rounded-md border border-line object-contain" />
              ) : (
                <span className={cn('text-ink', text ? 'text-sm leading-normal' : 'break-words text-[22px] font-semibold')}>
                  {o.label}
                </span>
              )}
              {o.why && <span className="text-sm leading-normal text-ink-3">{o.why}</span>}
              {text && field.value_en && i === 0 && (
                <span className="text-xs leading-normal text-ink-2">EN · {stripHtml(field.value_en)}</span>
              )}
            </button>
          ))}
        </div>

        {field.sources.length > 0 && (
          <section className="flex flex-col rounded-lg border border-line bg-canvas">
            <h2 className="m-0 border-b border-line-2 px-[18px] py-3.5 text-base font-semibold">Какво казват източниците</h2>
            {field.sources.slice(0, 6).map((s, i) => (
              <div key={i} className="grid grid-cols-[180px_170px_minmax(0,1fr)] items-baseline gap-4 border-b border-line-2 px-[18px] py-3 text-sm last:border-b-0">
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" className="truncate">
                    {host(s.url)}
                  </a>
                ) : (
                  <span>{s.title}</span>
                )}
                <span className="truncate font-medium">{s.says ?? (s.width ? `${s.width}×${s.height} px` : '')}</span>
                <span className="truncate text-ink-2">{s.error ?? s.title ?? ''}</span>
              </div>
            ))}
          </section>
        )}

        <div className="grow" />
        {typing ? (
          <form
            className="flex items-center gap-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              saveTyped()
            }}
          >
            {text ? (
              <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} className="grow rounded-md border border-line bg-canvas p-2.5 text-sm" />
            ) : (
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} className="h-11 grow rounded-md border border-line bg-canvas px-3 text-base" />
            )}
            <Button type="submit" variant="primary" size="xl" disabled={!draft.trim() || decide.isPending}>
              Запази и продължи
            </Button>
            <Button type="button" size="xl" onClick={() => setTyping(false)}>
              Откажи
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5">
            {!(blockedCurrent && options.length === 1) && (
              <Button variant="primary" size="xl" disabled={blockedCurrent || decide.isPending} onClick={apply}>
                <span className="max-w-[420px] truncate">{acceptLabel}</span>
              </Button>
            )}
            {!isImage && (
              <Button
                size="xl"
                variant={blockedCurrent && options.length === 1 ? 'primary' : 'secondary'}
                onClick={() => {
                  setDraft(text ? stripHtml(field.value) : display(field.value))
                  setTyping(true)
                }}
              >
                Въведи друга стойност
              </Button>
            )}
            <Button variant="ghost" size="xl" onClick={onSkip}>
              Пропусни засега
            </Button>
            <div className="grow" />
            <span className="whitespace-nowrap text-xs text-ink-2">
              {options.length > 1 ? `1–${options.length} избери · Enter приеми · ` : ''}S пропусни
            </span>
          </div>
        )}
        {decide.isError && <div className="text-sm text-blocked-text">{(decide.error as Error).message}</div>}
      </main>

      <Context batch={batch} product={product} />
    </>
  )
}

function Context({ batch, product }: { batch: Batch; product: Product }) {
  const first = Object.values(product.stores)[0]?.fields ?? {}
  const image = display(first.image?.value)
  const original = product.media.find((m) => m.kind === 'original')
  const row = (k: string, f?: FieldRecord) => ({ k, v: f ? display(f.value) || '—' : '—', status: f?.status ?? 'ok' })
  const rows = [
    row('SKU', first.sku),
    row('Пол', first.gender),
    row('Семейство', first.fragrance_family),
    ...batch.stores.map((s) => {
      const f = product.stores[s.key]?.fields ?? {}
      const status = [f.price?.status, f.compare_at?.status].includes('blocked') ? 'blocked' : 'ok'
      return { k: `Цена ${storeShort(s)}`, v: `${display(f.price?.value) || '—'} / ${display(f.compare_at?.value) || '—'}`, status: status as Status }
    }),
  ]
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col gap-[18px] border-l border-line bg-canvas px-5 py-6 xl:flex">
      <div className="flex h-[220px] items-center justify-center overflow-hidden rounded-md bg-well">
        {image.startsWith('/api/media/') || image.startsWith('http') ? (
          <img src={image} alt={product.title} className="h-full w-full bg-canvas object-contain" />
        ) : (
          <span className="flex flex-col items-center gap-2 text-xs text-ink-2">
            <ImageOff size={16} /> Няма снимка
          </span>
        )}
      </div>
      {original && <div className="-mt-2.5 text-xs text-ink-2">Оригинал {original.width}×{original.height} px</div>}
      <div className="flex flex-col gap-2.5 text-sm">
        <h3 className="m-0 text-sm font-semibold">Останалото в продукта</h3>
        {rows.map((r) => (
          <div key={r.k} className="flex justify-between gap-3">
            <span className="text-ink-2">{r.k}</span>
            <span className={cn('truncate text-right font-medium', r.status === 'blocked' ? 'text-blocked-text' : r.status === 'suggested' ? 'text-suggested-text' : '')}>
              {r.v}
            </span>
          </div>
        ))}
      </div>
    </aside>
  )
}
