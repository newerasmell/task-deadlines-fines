import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { FieldPanel } from '../components/FieldPanel'
import { Empty, Failure, Loading } from '../components/States'
import { StatusMark } from '../components/StatusMark'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { api, type AuditItem, type AuditIssue, type CrossSyncTaken } from '../lib/api'
import { cn } from '../lib/cn'
import { display, fieldLabel, groupLabel, plural, stripHtml } from '../lib/labels'
import { useAudit, useAuditItems, useProduct, useStores } from '../lib/queries'

// Audit of an existing catalog (Audit.dc.html): findings by rule with what the system does, the products
// behind each, a fix in place, and the CSV of all fixes for Shopify's import.

const EXPLAIN: Record<string, string> = {
  blocked: 'Системата не знае коя стойност е вярната, затова само ги показва. Поправи ги тук или в Shopify.',
  fixed: 'Поправено автоматично; поправката влиза в CSV-то за Shopify. Ако е грешна, промени я.',
  warning: 'Не спира нищо. Реши дали да го поправиш; поправеното влиза в CSV-то.',
  suggested: 'Предложение за преглед: приеми го или го промени.',
}
const TAKEN = '__taken' // the „Взети от другите магазини“ tab, not a rule
const PRICE_RULES = new Set(['compare_at_not_above', 'compare_at_ratio', 'price_missing'])

export function AuditScreen() {
  const batchId = Number(useParams().batchId)
  const summary = useAudit(batchId)
  const stores = useStores()
  const [rule, setRule] = useState<string | null>(null)
  const [limit, setLimit] = useState(50)
  const [open, setOpen] = useState<{ productId: number; key: string } | null>(null)
  const current = rule ?? summary.data?.issues[0]?.rule ?? null
  const items = useAuditItems(batchId, current === TAKEN ? null : current, limit)
  const taken = useQuery({ queryKey: ['crosssync-taken', batchId], queryFn: () => api.crossSyncTaken(batchId) })
  const opened = useProduct(open?.productId ?? null) // only this product, not the whole catalog

  if (summary.isPending) return <Loading what="одита" />
  if (summary.isError) return <Failure error={summary.error} retry={() => summary.refetch()} />
  const s = summary.data
  const store = stores.data?.find((x) => x.key === s.store)
  const issue = s.issues.find((i) => i.rule === current)
  const product = open && opened.data?.id === open.productId ? opened.data : null

  return (
    <div className="flex h-screen min-w-[1024px] flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line px-7">
        <div className="flex items-center gap-2 text-base">
          <Link to="/audits" className="text-ink-2 no-underline hover:text-ink">
            Одит на каталог
          </Link>
          <span className="text-muted">/</span>
          <span className="font-semibold">
            {store ? `${store.label.split(' (')[0]} ${store.country ?? ''}` : s.store}, {groupLabel(s.group)}
          </span>
          <span className="text-ink-2">{plural(s.products, 'продукт', 'продукта')}</span>
        </div>
        <div className="grow" />
        <Button asChild>
          <Link to={`/batches/${batchId}/grid`}>Отвори в таблица</Link>
        </Button>
        <CrossSync batchId={batchId} />
        <LiveAll batchId={batchId} />
        <Button variant="primary" asChild>
          <a href={`/api/batches/${batchId}/fix.csv`} download aria-disabled={!s.fix_products}>
            <Download size={16} /> CSV с поправките ({plural(s.fix_products, 'продукт', 'продукта')})
          </a>
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        <section
          className={cn(
            'flex shrink-0 flex-col overflow-y-auto border-r border-line',
            open ? 'w-[360px]' : 'w-[520px] xl:w-[620px]',
          )}
        >
          <div
            className={cn(
              'grid border-b border-line bg-surface text-xs font-medium text-ink-2',
              open ? 'grid-cols-[minmax(0,1fr)_64px]' : 'grid-cols-[minmax(0,1fr)_70px_190px]',
            )}
          >
            <div className="px-5 py-2.5">Проблем</div>
            <div className="px-3 py-2.5 text-right">Брой</div>
            {!open && <div className="px-5 py-2.5">Какво прави системата</div>}
          </div>
          {!!taken.data?.items.length && (
            <button
              onClick={() => {
                setRule(TAKEN)
                setOpen(null)
              }}
              className={cn(
                'flex items-center gap-2 border-0 border-b border-line-2 bg-canvas px-5 py-3 text-left text-sm hover:bg-surface',
                current === TAKEN && 'bg-suggested-tint',
              )}
            >
              <span className="grow font-medium">Взети от другите магазини</span>
              <span className="tabular text-ink-2">
                {taken.data.items.length}
                {taken.data.pending ? ` · ${taken.data.pending} за качване` : ' · качени'}
              </span>
            </button>
          )}
          {s.issues.map((i) => (
            <IssueRow
              key={i.rule}
              i={i}
              compact={!!open}
              active={i.rule === current}
              onClick={() => {
                setRule(i.rule)
                setLimit(50)
                setOpen(null)
              }}
            />
          ))}
          {!s.issues.length && <Empty>Каталогът минава всички проверки.</Empty>}
        </section>

        <section className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-7 py-6">
          {current === TAKEN && taken.data && <TakenList batchId={batchId} data={taken.data} />}
          {current !== TAKEN && issue && (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="m-0 text-lg font-semibold">{issue.label}</h2>
                <span className="text-sm leading-normal text-ink-2">{EXPLAIN[issue.status]}</span>
              </div>
              {items.isError ? (
                <Failure error={items.error} retry={() => items.refetch()} />
              ) : !items.data ? (
                <Loading what="продуктите" />
              ) : (
                <>
                  <ItemsTable
                    batchId={batchId}
                    rule={issue.rule}
                    items={items.data.items}
                    onFix={(it) => setOpen({ productId: it.product_id, key: it.key })}
                  />
                  <div className="flex items-center gap-3 text-xs text-ink-2">
                    Показани са {items.data.items.length} от {items.data.total}.
                    {items.data.items.length < items.data.total && (
                      <Button size="sm" onClick={() => setLimit(limit + 100)}>
                        Покажи още
                      </Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {open &&
          (product ? (
            <FieldPanel
              key={`${open.productId}-${open.key}`}
              batch={{
                id: batchId,
                kind: 'audit',
                name: s.name,
                group: s.group,
                created_at: s.created_at,
                author: null,
                stores: store ? [{ ...store }] : [],
                products: [product],
              }}
              product={product}
              store={s.store ?? Object.keys(product.stores)[0]}
              fieldKey={open.key}
              onClose={() => setOpen(null)}
            />
          ) : (
            <aside className="w-[400px] shrink-0 border-l border-line">
              {opened.isError ? <Failure error={opened.error} /> : <Loading what="продукта" />}
            </aside>
          ))}
      </div>
    </div>
  )
}

function IssueRow({
  i,
  active,
  compact,
  onClick,
}: {
  i: AuditIssue
  active: boolean
  compact: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'grid min-h-12 w-full items-center border-0 border-b border-line-2 text-left text-sm',
        compact ? 'grid-cols-[minmax(0,1fr)_64px]' : 'grid-cols-[minmax(0,1fr)_70px_190px]',
        active ? 'bg-suggested-tint shadow-[inset_3px_0_0_var(--color-accent)]' : 'bg-canvas hover:bg-surface',
      )}
    >
      <span className="flex items-center gap-2.5 px-5">
        <StatusMark status={i.status} />
        {i.label}
      </span>
      <span className="tabular px-3 text-right">{i.fields}</span>
      {!compact && <span className="px-5 text-ink-3">{i.action}</span>}
    </button>
  )
}

function ItemsTable({
  batchId,
  rule,
  items,
  onFix,
}: {
  batchId: number
  rule: string
  items: AuditItem[]
  onFix: (i: AuditItem) => void
}) {
  const prices = PRICE_RULES.has(rule)
  const cols = prices
    ? 'grid-cols-[minmax(0,1fr)_100px_120px_190px]'
    : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_190px]'
  const text = (v: unknown) => stripHtml(v).slice(0, 140)
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-line">
      <div className={`grid ${cols} border-b border-line bg-surface text-xs font-medium text-ink-2`}>
        <div className="px-3.5 py-2.5">Продукт</div>
        {prices ? (
          <>
            <div className="px-3.5 py-2.5 text-right">Цена</div>
            <div className="px-3.5 py-2.5 text-right">Зачеркната</div>
          </>
        ) : (
          <>
            <div className="px-3.5 py-2.5">Стойност</div>
            <div className="px-3.5 py-2.5">Преди</div>
          </>
        )}
        <div className="px-3.5 py-2.5" />
      </div>
      {items.map((it) => (
        <div key={it.field_id} className={`grid ${cols} items-center border-b border-line-2 text-sm last:border-b-0`}>
          <div className="flex min-w-0 flex-col px-3.5 py-2.5">
            <span className="truncate">{it.title}</span>
            {!prices && <span className="text-xs text-ink-2">{fieldLabel(it.key)}</span>}
          </div>
          {prices ? (
            <>
              <div className="tabular px-3.5 py-2.5 text-right">{display(it.price) || '—'}</div>
              <div
                className={cn(
                  'tabular px-3.5 py-2.5 text-right',
                  it.status === 'blocked' && 'bg-blocked-tint font-medium text-blocked-text',
                )}
              >
                {display(it.compare_at) || '—'}
              </div>
            </>
          ) : (
            <>
              <div className="min-w-0 truncate px-3.5 py-2.5" title={display(it.value)}>
                {text(it.value) || <span className="text-muted">празно</span>}
              </div>
              <div className="min-w-0 truncate px-3.5 py-2.5 text-ink-2" title={display(it.previous)}>
                {it.previous != null ? text(it.previous) : '—'}
              </div>
            </>
          )}
          <div className="flex gap-1.5 px-3.5 py-1.5">
            <Button size="sm" onClick={() => onFix(it)}>
              {it.decided_by ? 'Промени' : it.status === 'fixed' ? 'Провери' : 'Поправи'}
            </Button>
            <Button size="sm" variant="ghost" asChild title="Целият продукт и „Обнови в магазина“">
              <Link to={`/batches/${batchId}/products/${it.product_id}`}>Продукт</Link>
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** All fixes of the audit written live into the store (only the changed fields of each product). */
function LiveAll({ batchId }: { batchId: number }) {
  const client = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const state = useQuery({
    queryKey: ['live-batch', batchId],
    queryFn: () => api.liveBatch(batchId),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  })
  const s = state.data
  if (!s)
    return (
      <Button disabled title={state.isError ? (state.error as Error).message : undefined}>
        {state.isError ? 'Обнови в магазина: грешка' : 'Обнови в магазина: проверявам…'}
      </Button>
    )
  const start = async () => {
    setConfirm(false)
    setError(null)
    try {
      client.setQueryData(['live-batch', batchId], { ...(await api.startLiveBatch(batchId)), pending: s.pending })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <Button disabled={s.running || !s.pending} onClick={() => setConfirm(true)} title={error ?? undefined}>
        {s.running
          ? `Обновявам в магазина… ${s.done ?? 0}/${s.total ?? 0}`
          : s.total != null && !s.pending
            ? `Обновени в магазина: ${s.uploaded ?? 0}${s.failed ? `, грешки: ${s.failed}` : ''}`
            : `Обнови в магазина (${s.pending})`}
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Обнови поправките на живо?"
        description={`${s.pending} продукта в магазина ще получат поправките си веднага (само поправените полета; снимки, наличности и канали не се пипат). Спрени полета не се качват.`}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Откажи</Button>
            <Button variant="primary" onClick={() => void start()}>
              Обнови {s.pending} продукта
            </Button>
          </>
        }
      />
    </>
  )
}

/** Empty pictures, descriptions, notes… filled from the same products (EAN) in the other stores' catalogs, per
 * kind the person approves; pictures composed for this store, texts translated. */
function CrossSync({ batchId }: { batchId: number }) {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const options = useQuery({ queryKey: ['crosssync', batchId], queryFn: () => api.crossSync(batchId), enabled: open })
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && !q.state.data.running ? false : 2000),
  })
  const j = job.data
  const done = j && !j.running
  const kinds = options.data?.kinds ?? []
  const cost = kinds.filter((k) => picked.includes(k.kind)).reduce((sum, k) => sum + k.cost_usd, 0)

  const start = async () => {
    setError(null)
    try {
      setJobId((await api.startCrossSync(batchId, picked)).job_id)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const close = (o: boolean) => {
    setOpen(o)
    if (!o && done) {
      setJobId(null)
      setPicked([])
      void client.invalidateQueries()
    }
  }
  return (
    <>
      <Button onClick={() => setOpen(true)}>Попълни от другите магазини</Button>
      <Dialog
        open={open}
        onOpenChange={close}
        title="Попълни от другите магазини"
        description="Същите продукти (по EAN) в каталозите на другите магазини имат това, което тук липсва. Избери какво одобряваш: снимките се сглобяват по фона на този магазин, описанията и нотките се превеждат. После „Обнови в магазина“ го качва."
        footer={
          j ? (
            <Button onClick={() => close(false)}>{j.running ? 'Скрий (продължава)' : 'Затвори'}</Button>
          ) : (
            <>
              <Button onClick={() => close(false)}>Откажи</Button>
              <Button variant="primary" disabled={!picked.length} onClick={() => void start()}>
                Попълни{cost ? ` (≈ $${cost.toFixed(2)})` : ''}
              </Button>
            </>
          )
        }
      >
        {j ? (
          j.running ? (
            <span className="text-sm text-ink-2">
              {j.stage_label}… {j.done} от {j.total}
            </span>
          ) : j.error ? (
            <span className="text-sm text-blocked-text">{j.error}</span>
          ) : (
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-ok">
                Готово{j.cost_usd ? ` · $${j.cost_usd.toFixed(2)}` : ''}. Провери продуктите и „Обнови в магазина“.
              </span>
              {Object.entries(j.result ?? {}).map(([k, v]) => (
                <span key={k}>
                  {k}: {v}
                </span>
              ))}
            </div>
          )
        ) : options.isPending ? (
          <Loading what="каталозите" />
        ) : options.isError ? (
          <Failure error={options.error} />
        ) : !kinds.length ? (
          <span className="text-sm text-ink-2">
            Няма какво да се вземе: или нищо не липсва, или другите магазини още нямат одит с тези продукти.
          </span>
        ) : (
          <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto">
            {kinds.map((k) => (
              <label key={k.kind} className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={picked.includes(k.kind)}
                  onChange={(e) =>
                    setPicked(e.target.checked ? [...picked, k.kind] : picked.filter((x) => x !== k.kind))
                  }
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">
                    {k.label}: {plural(k.products, 'продукт', 'продукта')}
                    {k.cost_usd ? ` · ≈ $${k.cost_usd.toFixed(2)}` : ''}
                  </span>
                  <span className="text-xs text-ink-2">от {k.from.join(', ')}</span>
                  {k.examples.slice(0, 3).map((e, i) => (
                    <span key={i} className="truncate text-xs text-ink-3" title={e.value}>
                      {e.title} ← {e.from}: {k.kind === 'image' ? 'снимка' : stripHtml(e.value)}
                    </span>
                  ))}
                </span>
              </label>
            ))}
          </div>
        )}
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </Dialog>
    </>
  )
}

/** The products that took something from the other stores: what, a preview, live state; update one or all. */
function TakenList({ batchId, data }: { batchId: number; data: CrossSyncTaken }) {
  const client = useQueryClient()
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['crosssync-taken', batchId] })
    void client.invalidateQueries({ queryKey: ['live-batch', batchId] })
  }
  const pushOne = async (productId: number) => {
    setBusy(productId)
    setError(null)
    try {
      await api.pushLive(productId)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      refresh()
    }
  }
  const pending = data.items.filter((i) => i.live_status !== 'uploaded').map((i) => i.product_id)
  const pushAll = async () => {
    setBusy('all')
    setError(null)
    try {
      await api.startLiveBatch(batchId, pending)
      const wait = async () => {
        const state = await api.liveBatch(batchId)
        if (state.running) setTimeout(() => void wait(), 2000)
        else {
          setBusy(null)
          refresh()
        }
      }
      void wait()
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex grow flex-col gap-1">
          <h2 className="m-0 text-lg font-semibold">Взети от другите магазини</h2>
          <span className="text-sm text-ink-2">
            {data.items.length} продукта получиха нещо от каталозите на другите магазини. Провери и ги обнови в
            магазина.
          </span>
        </div>
        <Button variant="primary" disabled={!pending.length || busy !== null} onClick={() => void pushAll()}>
          {busy === 'all' ? 'Обновявам…' : `Обнови всички тези в магазина (${pending.length})`}
        </Button>
      </div>
      {error && <span className="text-sm text-blocked-text">{error}</span>}
      <div className="flex flex-col rounded-lg border border-line" role="table" aria-label="Взети от другите магазини">
        {data.items.map((it) => (
          <div
            key={it.product_id}
            role="row"
            className="grid grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)_190px] items-center gap-3 border-b border-line-2 px-3.5 py-2 text-sm last:border-b-0"
          >
            {it.image ? (
              <img src={String(it.image)} alt="" className="h-12 w-12 rounded border border-line object-contain" />
            ) : (
              <span />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium" title={it.title}>
                {it.title}
              </span>
              <span className="text-xs text-ink-2">{it.kinds.join(', ')}</span>
            </span>
            <span
              className={cn(
                'min-w-0 truncate text-xs',
                it.live_status === 'uploaded'
                  ? 'text-ok'
                  : it.live_status === 'failed'
                    ? 'text-blocked-text'
                    : 'text-ink-2',
              )}
              title={it.live_message ?? undefined}
            >
              {it.live_status === 'uploaded'
                ? 'качено в магазина'
                : it.live_status === 'failed'
                  ? it.live_message
                  : 'за качване'}
            </span>
            <span className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" asChild>
                <Link to={`/batches/${batchId}/products/${it.product_id}`}>Продукт</Link>
              </Button>
              <Button size="sm" disabled={busy !== null} onClick={() => void pushOne(it.product_id)}>
                {busy === it.product_id ? '…' : it.live_status === 'uploaded' ? 'Отново' : 'Обнови'}
              </Button>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
