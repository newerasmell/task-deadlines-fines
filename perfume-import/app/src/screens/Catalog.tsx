import { ImageOff, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { AppNav } from '../components/AppNav'
import { JobBanner } from '../components/JobBanner'
import { Empty, Failure, Loading } from '../components/States'
import { StateLegend, StoreChips } from '../components/StoreChips'
import { Button } from '../components/ui/button'
import type { CatalogEntry, CatalogFilter, CatalogStore } from '../lib/api'
import { cn } from '../lib/cn'
import { ago, plural } from '../lib/labels'
import { useCatalog, useLatestJob, useStores, useSyncStores } from '../lib/queries'

// Продукти: every product of every store in one list, found by name or EAN. A row opens the product; a store
// square opens that store's copy.

const FILTERS: { key: CatalogFilter; label: string }[] = [
  { key: 'all', label: 'Всички' },
  { key: 'todo', label: 'Има промени за качване' },
  { key: 'bad', label: 'Нужна е намеса' },
  { key: 'missing', label: 'Липсва в някой магазин' },
  { key: 'fixes', label: 'Автоматични поправки' },
]
const PAGE = 100
const COLUMNS = 'grid-cols-[44px_minmax(0,1fr)_120px_auto_170px]'

function todo(entry: CatalogEntry): { text: string; tone: string } {
  const states = Object.values(entry.stores).map((s) => s.state)
  const bad = states.filter((s) => s === 'bad').length
  const waiting = states.filter((s) => s === 'diff' || s === 'ready').length
  if (bad) return { text: `Нужна е намеса в ${bad === 1 ? '1 магазин' : `${bad} магазина`}`, tone: 'text-blocked-text' }
  if (waiting)
    return { text: `Качи в ${waiting === 1 ? '1 магазин' : `${waiting} магазина`}`, tone: 'text-warning-text' }
  if (entry.fixes)
    return {
      text: `Автоматични поправки в ${entry.fixes === 1 ? '1 магазин' : `${entry.fixes} магазина`}`,
      tone: 'text-fixed-text',
    }
  return { text: 'Всичко е качено', tone: 'text-ok' }
}

export function CatalogScreen() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const filter = (params.get('f') as CatalogFilter | null) ?? 'all'
  const [text, setText] = useState(q)
  const [limit, setLimit] = useState(PAGE)
  const catalog = useCatalog(q, filter, limit)
  const sync = useSyncStores()

  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (text.trim() === q) return
    const t = setTimeout(() => {
      setLimit(PAGE)
      setParams(
        (p) => {
          const next = new URLSearchParams(p)
          if (text.trim()) next.set('q', text.trim())
          else next.delete('q')
          return next
        },
        { replace: true },
      )
    }, 250)
    return () => clearTimeout(t)
  }, [text, q, setParams])

  const pick = (f: CatalogFilter) => {
    setLimit(PAGE)
    setParams((p) => {
      const next = new URLSearchParams(p)
      if (f === 'all') next.delete('f')
      else next.set('f', f)
      return next
    })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b border-line px-7">
        <AppNav />
      </header>
      <main className="flex flex-col gap-3.5 px-7 py-6">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="m-0 text-lg font-semibold">Продукти</h1>
          {catalog.data && (
            <span className="tabular text-sm text-ink-2">
              {plural(catalog.data.total, 'продукт', 'продукта')} в{' '}
              {plural(catalog.data.stores.length, 'магазин', 'магазина')}
            </span>
          )}
          <div className="grow" />
          <Link to="/batches" className="text-sm no-underline">
            История на вноса
          </Link>
          <SyncButton sync={sync} />
          <Button variant="primary" asChild>
            <Link to="/new">Нов продукт</Link>
          </Button>
        </div>

        {sync.error && <div className="text-sm text-blocked-text">{sync.error.message}</div>}
        <JobBanner only={['sync']} />

        <label className="relative block max-w-[640px]">
          <span className="sr-only">Търси продукт</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Търси по име, марка или EAN"
            autoFocus
            className="h-10 w-full rounded-md border border-line bg-canvas pl-9 pr-3 text-base outline-none focus:border-accent"
          />
        </label>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Покажи">
          {FILTERS.map((f) => (
            <Button key={f.key} variant="chip" size="sm" aria-pressed={filter === f.key} onClick={() => pick(f.key)}>
              {f.label}
              {catalog.data && <span className="tabular text-ink-2">{catalog.data.counts[f.key]}</span>}
            </Button>
          ))}
        </div>

        {catalog.isPending ? (
          <Loading what="продуктите" />
        ) : catalog.isError ? (
          <Failure error={catalog.error} retry={() => catalog.refetch()} />
        ) : !catalog.data.total ? (
          <Empty>
            Още няма продукти. Свържи магазин и качи каталога му в <Link to="/stores">Магазини</Link> или създай{' '}
            <Link to="/new">нов продукт</Link>.
          </Empty>
        ) : !catalog.data.items.length ? (
          <Empty>
            Няма продукт{q ? ` с „${q}“` : ''} в този изглед. Опитай с част от името или EAN
            {filter !== 'all' ? ', или избери „Всички“' : ''}.
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <div role="table" aria-label="Продукти" className="min-w-[900px]">
                <div
                  role="row"
                  className={`grid ${COLUMNS} items-center border-b border-line bg-surface text-xs font-medium text-ink-2`}
                >
                  <div role="columnheader" />
                  <div role="columnheader" className="px-3 py-[9px]">
                    Продукт
                  </div>
                  <div role="columnheader" className="px-3 py-[9px]">
                    EAN
                  </div>
                  <div role="columnheader" className="px-3 py-[9px]">
                    Магазини
                  </div>
                  <div role="columnheader" className="px-3 py-[9px]">
                    Какво остава
                  </div>
                </div>
                {catalog.data.items.map((e) => (
                  <Row key={e.key} entry={e} stores={catalog.data.stores} />
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <StateLegend />
              <div className="grow" />
              {catalog.data.found > catalog.data.items.length && (
                <Button onClick={() => setLimit(limit + PAGE)} disabled={catalog.isFetching}>
                  Покажи още {Math.min(PAGE, catalog.data.found - catalog.data.items.length)} от {catalog.data.found}
                </Button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/** Reads every connected store's products from Shopify now (it also happens by itself every few hours). */
function SyncButton({ sync }: { sync: ReturnType<typeof useSyncStores> }) {
  const job = useLatestJob()
  const stores = useStores()
  const running = !!job.data?.running
  const last = (stores.data ?? [])
    .map((s) => s.checked_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(0)
  return (
    <span className="flex items-center gap-2">
      {last && <span className="text-xs text-ink-2">най-старото изтегляне: {ago(last)}</span>}
      <Button onClick={() => sync.mutate(undefined)} disabled={running || sync.isPending} title={sync.error?.message}>
        {running && job.data?.kind === 'sync' ? 'Изтегля се…' : 'Изтегли от магазините'}
      </Button>
    </span>
  )
}

function Row({ entry, stores }: { entry: CatalogEntry; stores: CatalogStore[] }) {
  const navigate = useNavigate()
  const to = `/batches/${entry.batch_id}/products/${entry.product_id}`
  const t = todo(entry)
  return (
    <div
      role="row"
      onClick={() => navigate(to)}
      className={cn(
        `grid ${COLUMNS} min-h-[44px] cursor-pointer items-center border-b border-line-2 text-sm last:border-b-0`,
        'hover:bg-surface',
      )}
    >
      <div role="cell" className="flex justify-center py-1">
        {entry.image ? (
          <img
            src={entry.image}
            alt=""
            loading="lazy"
            className="h-8 w-8 rounded-[4px] border border-line object-contain"
          />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-line bg-well text-muted">
            <ImageOff size={14} />
          </span>
        )}
      </div>
      <div role="cell" className="min-w-0 px-3">
        <Link to={to} className="line-clamp-2 font-medium text-ink no-underline hover:text-accent">
          {entry.title || 'Без име'}
        </Link>
      </div>
      <div role="cell" className="tabular px-3 text-ink-2">
        {entry.ean ?? <span className="text-blocked-text">няма EAN</span>}
      </div>
      <div role="cell" className="px-3">
        <StoreChips entry={entry} stores={stores} />
      </div>
      <div role="cell" className={cn('px-3 text-xs', t.tone)}>
        {t.text}
      </div>
    </div>
  )
}
