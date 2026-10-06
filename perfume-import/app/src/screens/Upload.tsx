import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Empty, Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import type { UploadItem, UploadStore } from '../lib/api'
import { cn } from '../lib/cn'
import { groupLabel, languageName, plural, shortDate, storeShort } from '../lib/labels'
import { useBatch, useStartUpload, useUploadState } from '../lib/queries'

// Upload (Upload.dc.html): approved products go to every store as drafts or active; results per store,
// retry only what failed.

export function UploadScreen() {
  const batchId = Number(useParams().batchId)
  const batch = useBatch(batchId)
  const state = useUploadState(batchId)
  const start = useStartUpload(batchId)
  const [mode, setMode] = useState<'draft' | 'active'>('draft')
  const wasRunning = useRef(false)

  // When a run ends, refresh the batch so the product list shows what went up.
  useEffect(() => {
    if (wasRunning.current && state.data && !state.data.running) batch.refetch()
    wasRunning.current = !!state.data?.running
  }, [state.data, batch])

  if (batch.isPending || state.isPending) return <Loading what="качването" />
  if (batch.isError) return <Failure error={batch.error} retry={() => batch.refetch()} />
  if (state.isError) return <Failure error={state.error} retry={() => state.refetch()} />
  const s = state.data
  const b = batch.data

  const shown = (store: UploadStore) => store.items.filter((i) => !i.blocker || i.upload_status)
  const approved = new Set(s.stores.flatMap((st) => st.items.filter((i) => !i.blocker).map((i) => i.product_id)))
  const waiting = b.products.length - approved.size
  const toSend = s.stores.reduce((n, st) => n + (st.configured ? 0 : st.items.filter((i) => !i.blocker).length), 0)
  const storesReady = s.stores.filter((st) => !st.configured && st.items.some((i) => !i.blocker))
  const anyUploaded = s.stores.some((st) => st.items.some((i) => i.upload_status === 'uploaded'))
  const error = (start.error as Error | null)?.message ?? s.error

  return (
    <div className="flex min-h-screen min-w-[1024px] flex-col bg-canvas">
      <header className="flex h-14 items-center gap-4 border-b border-line px-7">
        <div className="flex items-center gap-2 text-base">
          <Link to="/" className="text-ink-2 no-underline hover:text-ink">
            Партиди
          </Link>
          <span className="text-muted">/</span>
          <Link to={`/batches/${b.id}`} className="text-ink-2 no-underline hover:text-ink">
            {shortDate(b.created_at)}, {groupLabel(b.group)}
          </Link>
          <span className="text-muted">/</span>
          <span className="font-semibold">Качване</span>
        </div>
      </header>

      <main className="flex max-w-[1100px] flex-col gap-5 p-7">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[22px] font-semibold">
            Качване на {plural(approved.size, 'одобрен продукт', 'одобрени продукта')}
          </h1>
          <span className="text-sm text-ink-2">
            {mode === 'draft' ? 'Като чернови.' : 'Като активни: видими в магазина веднага.'}{' '}
            {waiting > 0
              ? `${plural(waiting, 'продукт остава', 'продукта остават')} в партидата, докато не ${waiting === 1 ? 'бъде одобрен' : 'бъдат одобрени'}.`
              : 'Всички продукти в партидата са одобрени.'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <fieldset className="m-0 flex gap-4 border-0 p-0 text-base" disabled={s.running}>
            <legend className="sr-only">Как да се качат</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'draft'} onChange={() => setMode('draft')} /> Като чернови
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="mode" checked={mode === 'active'} onChange={() => setMode('active')} /> Като активни
            </label>
          </fieldset>
          <Button
            variant="primary"
            size="lg"
            disabled={s.running || !toSend || start.isPending}
            onClick={() => start.mutate({ status: mode, stores: storesReady.map((st) => st.key) })}
          >
            {s.running
              ? `Качвам ${s.done} от ${s.total}…`
              : toSend
                ? `${anyUploaded ? 'Качи отново' : 'Качи'} ${plural(toSend, 'продукт', 'продукта')} в ${plural(storesReady.length, 'сайт', 'сайта')}`
                : approved.size
                  ? 'Първо настрой сайтовете (виж по-долу)'
                  : 'Още няма одобрени продукти'}
          </Button>
          {waiting > 0 && (
            <Button asChild>
              <Link to={`/batches/${b.id}/queue`}>Реши чакащите</Link>
            </Button>
          )}
        </div>
        {error && <div className="text-sm text-blocked-text">{error}</div>}

        {s.stores.map((store) => (
          <StoreSection
            key={store.key}
            batchId={b.id}
            store={store}
            items={shown(store)}
            running={s.running}
            onRetry={() => start.mutate({ status: mode, stores: [store.key], only_failed: true })}
          />
        ))}
        {!s.stores.length && <Empty>Партидата няма продукти.</Empty>}
      </main>
    </div>
  )
}

function StoreSection({
  batchId,
  store,
  items,
  running,
  onRetry,
}: {
  batchId: number
  store: UploadStore
  items: UploadItem[]
  running: boolean
  onRetry: () => void
}) {
  const uploaded = items.filter((i) => i.upload_status === 'uploaded').length
  const failed = items.filter((i) => i.upload_status === 'failed').length
  const name = `${store.label} · ${storeShort({ ...store, currency: null })} · ${languageName(store.language)}`
  const summary = failed
    ? `${uploaded} от ${items.length} качени, ${failed} с грешка`
    : uploaded
      ? `${uploaded} от ${items.length} качени`
      : `${plural(items.length, 'продукт', 'продукта')} за качване`

  return (
    <section className="shrink-0 overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-3 border-b border-line bg-surface px-[18px] py-3.5">
        <span className="text-base font-semibold">{name}</span>
        <span className={cn('text-sm', failed ? 'text-blocked-text' : uploaded ? 'text-ok' : 'text-ink-2')}>{summary}</span>
        <div className="grow" />
        {failed > 0 && !store.configured && (
          <Button size="sm" className="h-8 px-3" disabled={running} onClick={onRetry}>
            Опитай отново неуспешните
          </Button>
        )}
      </div>
      {store.configured && (
        <div className="border-b border-line-2 bg-blocked-tint px-[18px] py-2.5 text-sm text-blocked-text">
          {store.configured}
        </div>
      )}
      {items.map((i) => (
        <div
          key={i.store_product_id}
          className="grid grid-cols-[minmax(0,1fr)_150px_320px] items-center gap-4 border-b border-line-2 px-[18px] py-2.5 text-sm last:border-b-0"
        >
          <Link to={`/batches/${batchId}/products/${i.product_id}`} className="truncate text-ink no-underline hover:text-accent">
            {i.title}
          </Link>
          <span
            className={cn(
              'font-medium',
              i.upload_status === 'uploaded' ? 'text-ok' : i.upload_status === 'failed' ? 'text-blocked-text' : 'text-ink-2',
            )}
          >
            {i.upload_status === 'uploaded'
              ? 'качен'
              : i.upload_status === 'failed'
                ? 'грешка'
                : i.blocker
                  ? 'не е одобрен'
                  : store.configured
                    ? 'чака настройка'
                    : 'готов за качване'}
          </span>
          <span className="text-ink-2">
            {i.upload_message ?? i.blocker ?? ''}
            {i.shopify_url && (
              <>
                {' '}
                <a href={i.shopify_url} target="_blank" rel="noreferrer">
                  Отвори в Shopify
                </a>
              </>
            )}
          </span>
        </div>
      ))}
      {!items.length && <div className="px-[18px] py-3 text-sm text-ink-2">Няма одобрени продукти за този сайт.</div>}
    </section>
  )
}
