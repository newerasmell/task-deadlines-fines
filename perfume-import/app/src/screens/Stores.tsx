import { Link } from 'react-router'
import { AppNav } from '../components/AppNav'
import { Empty, Failure, Loading } from '../components/States'
import { StatusMark } from '../components/StatusMark'
import { Button } from '../components/ui/button'
import type { StoreRow } from '../lib/api'
import { languageName, shortDate } from '../lib/labels'
import { useStores } from '../lib/queries'

// Stores (Stores.dc.html): every store, its group, its profile and the last catalog upload.

const COLUMNS =
  'grid-cols-[170px_56px_140px_84px_170px_minmax(0,1fr)_200px] xl:grid-cols-[220px_70px_150px_100px_190px_minmax(0,1fr)_210px]'

const STATE = {
  active: { label: 'активен', status: 'ok' as const },
  proposed: { label: 'чака потвърждение', status: 'suggested' as const },
  waiting: { label: 'чака каталог', status: 'warning' as const },
}

function action(s: StoreRow): { label: string; to: string } {
  if (s.state === 'proposed' && s.profile_id) return { label: 'Потвърди профила', to: `/profiles/${s.profile_id}` }
  if (s.state === 'active') return { label: 'Обнови каталога', to: `/stores/new?store=${s.key}` }
  return { label: 'Качи каталог', to: `/stores/new?store=${s.key}` }
}

export function StoresScreen() {
  const stores = useStores()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b border-line px-7">
        <AppNav />
        <div className="grow" />
        <Button variant="primary" asChild>
          <Link to="/stores/new">Добави магазин</Link>
        </Button>
      </header>
      <main className="flex flex-col gap-3.5 px-7 py-6">
        {stores.isPending ? (
          <Loading what="магазините" />
        ) : stores.isError ? (
          <Failure error={stores.error} retry={() => stores.refetch()} />
        ) : !stores.data.length ? (
          <Empty>Няма магазини. Добави първия с експорт от Shopify.</Empty>
        ) : (
          <>
            <div className="flex items-baseline gap-3">
              <h1 className="m-0 text-[22px] font-semibold">{stores.data.length} магазина</h1>
              <span className="text-sm text-ink-2">
                Всеки магазин има собствен профил, изведен от качения му каталог. Новите продукти се генерират по профила
                на всеки магазин.
              </span>
            </div>
            <div className="overflow-hidden rounded-lg border border-line" role="table" aria-label="Магазини">
              <div role="row" className={`grid ${COLUMNS} border-b border-line bg-surface text-xs font-medium text-ink-2`}>
                <div role="columnheader" className="px-3.5 py-[9px]">Магазин</div>
                <div role="columnheader" className="px-3.5 py-[9px]">Група</div>
                <div role="columnheader" className="px-3.5 py-[9px]">Държава · език</div>
                <div role="columnheader" className="px-3.5 py-[9px] text-right">Продукти</div>
                <div role="columnheader" className="px-3.5 py-[9px]">Профил</div>
                <div role="columnheader" className="px-3.5 py-[9px]">Каталог · достъп</div>
                <div role="columnheader" className="px-3.5 py-[9px]" />
              </div>
              {stores.data.map((s) => {
                const a = action(s)
                const state = STATE[s.state]
                return (
                  <div role="row" key={s.key} className={`grid ${COLUMNS} h-[37px] items-center border-b border-line-2 text-sm last:border-b-0`}>
                    <div role="cell" className="truncate px-3.5 font-medium" title={s.label}>
                      {s.label.split(' (')[0]}
                    </div>
                    <div role="cell" className="px-3.5 text-ink-3">{s.group?.replace('group-', '') ?? '—'}</div>
                    <div role="cell" className="px-3.5 text-ink-3">
                      {s.country ?? '?'} · {languageName(s.language)}
                    </div>
                    <div role="cell" className="tabular px-3.5 text-right">{s.products ?? '—'}</div>
                    <div role="cell" className="flex items-center gap-2 px-3.5">
                      <StatusMark status={state.status} />
                      {state.label}
                    </div>
                    <div role="cell" className="truncate px-3.5 text-ink-2" title={s.access ?? undefined}>
                      {s.catalog_at ? shortDate(s.catalog_at) : 'не е качен'}
                      {s.state === 'active' && (s.access ? ' · без достъп до Shopify' : ` · ${s.shop}`)}
                    </div>
                    <div role="cell" className="flex justify-end gap-2 px-3.5">
                      {s.audit_batch_id && s.state === 'active' && (
                        <Link to={`/batches/${s.audit_batch_id}/audit`} className="self-center text-sm no-underline">
                          Одит
                        </Link>
                      )}
                      <Button size="sm" className="h-8 px-3" asChild>
                        <Link to={a.to}>{a.label}</Link>
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
