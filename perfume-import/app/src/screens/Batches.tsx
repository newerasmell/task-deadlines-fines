import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { AppNav } from '../components/AppNav'
import { Empty, Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import type { BatchSummary } from '../lib/api'
import { groupLabel, plural, shortDate, storeShort } from '../lib/labels'
import { useBatches, useLatestJob } from '../lib/queries'

const COLUMNS =
  'grid-cols-[150px_100px_100px_90px_minmax(0,1fr)_190px] xl:grid-cols-[200px_120px_140px_110px_minmax(0,1fr)_200px]'

function summary(b: BatchSummary): string {
  if (b.kind === 'audit') {
    return [
      b.fixed && plural(b.fixed, 'автоматична поправка', 'автоматични поправки'),
      b.blocked && `${b.blocked} ${b.blocked === 1 ? 'спрян продукт' : 'спрени продукта'}`,
      b.review && `${b.review} за преглед`,
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (b.publish_status === 'uploaded') return 'качени в магазините'
  if (b.products && b.approved === b.products) return 'всички одобрени, чакат качване'
  return [
    b.ready && `${b.ready} ${b.ready === 1 ? 'готов' : 'готови'}`,
    b.review && `${b.review} ${b.review === 1 ? 'чака' : 'чакат'} преглед`,
    b.blocked && `${b.blocked} ${b.blocked === 1 ? 'спрян' : 'спрени'}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function action(b: BatchSummary): { label: string; to: string } {
  if (b.kind === 'audit') return { label: 'Отвори одита', to: `/batches/${b.id}/audit` }
  if (b.publish_status === 'uploaded') return { label: 'Виж резултата', to: `/batches/${b.id}/upload` }
  if (b.products && b.approved === b.products) return { label: `Качи ${b.approved}`, to: `/batches/${b.id}/upload` }
  if (b.review || b.blocked)
    return { label: b.ready || b.approved ? 'Продължи прегледа' : 'Започни прегледа', to: `/batches/${b.id}` }
  return { label: 'Виж продуктите', to: `/batches/${b.id}` }
}

function Progress({ b }: { b: BatchSummary }) {
  const pct = (n: number) => `${b.products ? (n / b.products) * 100 : 0}%`
  return (
    <div className="flex h-1.5 max-w-[360px] overflow-hidden rounded-[3px] bg-line-2" aria-hidden>
      <div className="bg-ok" style={{ width: pct(b.ready) }} />
      <div className="bg-suggested" style={{ width: pct(b.review) }} />
      <div className="bg-blocked" style={{ width: pct(b.blocked) }} />
    </div>
  )
}

const DISMISSED = 'perfume-import.dismissed-job'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

// The new batch running on the server, or how the last one ended, so it never looks lost after leaving its
// progress screen.
function JobBanner() {
  const latest = useLatestJob()
  const client = useQueryClient()
  const [dismissed, setDismissed] = useState(readDismissed)
  const j = latest.data
  const finished = j && !j.running ? j.id : null
  useEffect(() => {
    if (finished) client.invalidateQueries({ queryKey: ['batches'] })
  }, [finished, client])
  if (!j || (!j.running && dismissed === j.id)) return null
  const dismiss = () => {
    setDismissed(j.id)
    try {
      localStorage.setItem(DISMISSED, j.id)
    } catch {
      /* only a convenience */
    }
  }
  const tone = j.running ? 'bg-surface' : j.error ? 'bg-blocked-tint' : 'bg-ok-tint'
  return (
    <div role="status" className={`flex items-center gap-4 rounded-lg border border-line px-4 py-3 text-sm ${tone}`}>
      {j.running ? (
        <>
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span className="font-medium">
              {j.kind === 'extend' ? 'Добавят се магазини към партида' : 'Проучва се нова партида'} · {j.stage_label}
              {j.stage === 'research' ? ` · ${j.done} от ${j.total}` : '…'}
            </span>
            <span className="text-xs text-ink-2">
              {plural(j.total, 'продукт', 'продукта')}. Не пускай deploy, докато върви: рестартът я спира.
            </span>
          </div>
          <Button asChild>
            <Link to={`/batches/new?job=${j.id}`}>Виж прогреса</Link>
          </Button>
        </>
      ) : j.error ? (
        <>
          <span className="min-w-0 grow text-blocked-text">Последната нова партида спря: {j.error}</span>
          <Button variant="ghost" size="icon" aria-label="Скрий" onClick={dismiss}>
            <X size={16} />
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 grow font-medium">
            Новата партида е готова{j.cost_usd != null ? ` · $${j.cost_usd.toFixed(2)}` : ''}
          </span>
          {j.batch_id && (
            <Button variant="primary" asChild>
              <Link to={`/batches/${j.batch_id}`}>Отвори</Link>
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label="Скрий" onClick={dismiss}>
            <X size={16} />
          </Button>
        </>
      )}
    </div>
  )
}

export function BatchesScreen({ kind }: { kind?: 'new' | 'audit' }) {
  const batches = useBatches()
  const [group, setGroup] = useState<string | null>(null)
  const [unfinished, setUnfinished] = useState(false)
  const groups = useMemo(() => [...new Set((batches.data ?? []).map((b) => b.group))].sort(), [batches.data])
  const shown = (batches.data ?? []).filter(
    (b) => (!kind || b.kind === kind) && (!group || b.group === group) && (!unfinished || b.review + b.blocked > 0),
  )

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b border-line px-7">
        <AppNav />
        <h1 className="sr-only">{kind === 'audit' ? 'Одит на каталог' : 'Партиди'}</h1>
        <div className="grow" />
        <Button variant="primary" asChild>
          <Link to="/batches/new">Нова партида</Link>
        </Button>
      </header>

      <main className="flex flex-col gap-4 p-7">
        {kind !== 'audit' && <JobBanner />}
        <div className="flex gap-2">
          <Button variant="chip" size="sm" aria-pressed={group === null} onClick={() => setGroup(null)}>
            Всички групи
          </Button>
          {groups.map((g) => (
            <Button key={g} variant="chip" size="sm" aria-pressed={group === g} onClick={() => setGroup(g)}>
              {groupLabel(g)}
            </Button>
          ))}
          <div className="grow" />
          <Button variant="chip" size="sm" aria-pressed={unfinished} onClick={() => setUnfinished(!unfinished)}>
            Само незавършени
          </Button>
        </div>

        {batches.isPending ? (
          <Loading what="партидите" />
        ) : batches.isError ? (
          <Failure error={batches.error} retry={() => batches.refetch()} />
        ) : !shown.length ? (
          <Empty>
            {batches.data.length
              ? 'Няма партиди по този филтър.'
              : kind === 'audit'
                ? 'Още няма одит. Качи каталог на магазин от „Магазини“.'
                : 'Още няма партиди. Създай първата с „Нова партида“ горе вдясно.'}
          </Empty>
        ) : (
          <div className="shrink-0 overflow-hidden rounded-lg border border-line" role="table" aria-label="Партиди">
            <div
              role="row"
              className={`grid ${COLUMNS} border-b border-line bg-surface text-xs font-medium text-ink-2`}
            >
              <div role="columnheader" className="px-4 py-2.5">Партида</div>
              <div role="columnheader" className="px-4 py-2.5">Група</div>
              <div role="columnheader" className="px-4 py-2.5">Сайтове</div>
              <div role="columnheader" className="px-4 py-2.5 text-right">Продукти</div>
              <div role="columnheader" className="px-4 py-2.5">Състояние</div>
              <div role="columnheader" className="px-4 py-2.5" />
            </div>
            {shown.map((b) => (
              <div
                role="row"
                key={b.id}
                className={`grid ${COLUMNS} min-h-14 items-center border-b border-line-2 text-sm last:border-b-0`}
              >
                <div role="cell" className="flex min-w-0 flex-col px-4 py-2">
                  <span className="font-medium">{shortDate(b.created_at)}</span>
                  <span className="truncate text-xs text-ink-2" title={b.name}>
                    {b.kind === 'audit' ? 'одит на каталог' : 'нови продукти'}
                    {b.name.startsWith('Демо') ? ' · демо' : ''}
                  </span>
                </div>
                <div role="cell" className="px-4">{groupLabel(b.group)}</div>
                <div role="cell" className="truncate px-4 text-ink-3">
                  {b.stores.map(storeShort).join(', ')}
                </div>
                <div role="cell" className="tabular px-4 text-right">{b.products}</div>
                <div role="cell" className="flex flex-col gap-1.5 px-4 py-2">
                  <Progress b={b} />
                  <span className="text-xs text-ink-2">{summary(b)}</span>
                </div>
                <div role="cell" className="flex justify-end px-4">
                  <Button asChild>
                    <Link to={action(b).to}>{action(b).label}</Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
