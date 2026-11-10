import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { Job } from '../lib/api'
import { plural } from '../lib/labels'
import { useLatestJob, useStores } from '../lib/queries'
import { Button } from './ui/button'

const DISMISSED = 'perfume-import.dismissed-job'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED)
  } catch {
    return null
  }
}

type SyncResult = { stores: { store: string; products: number; carried: number }[]; errors: string[] }

const RUNNING: Record<string, string> = {
  extend: 'Добавят се магазини към внос',
  crosssync: 'Попълва се от другите магазини',
  fill: 'Попълва се липсващото в продукт',
  sync: 'Изтеглят се продуктите от Shopify',
}

// The job running on the server, or how the last one ended, so it never looks lost after leaving its screen.
// only: show just these kinds (the product list shows only reading the stores).
export function JobBanner({ only }: { only?: Job['kind'][] }) {
  const latest = useLatestJob()
  const stores = useStores()
  const client = useQueryClient()
  const [dismissed, setDismissed] = useState(readDismissed)
  const j = latest.data
  const finished = j && !j.running ? j.id : null
  useEffect(() => {
    if (!finished) return
    client.invalidateQueries({ queryKey: ['batches'] })
    client.invalidateQueries({ queryKey: ['catalog'] })
    client.invalidateQueries({ queryKey: ['stores'] })
  }, [finished, client])
  if (!j || (!j.running && dismissed === j.id)) return null
  if (only && !only.includes(j.kind)) return null
  const label = (key: string | null | undefined) =>
    stores.data?.find((s) => s.key === key)?.label.split(' (')[0] ?? key ?? ''
  const dismiss = () => {
    setDismissed(j.id)
    try {
      localStorage.setItem(DISMISSED, j.id)
    } catch {
      /* only a convenience */
    }
  }
  const sync = j.kind === 'sync' ? (j.result as SyncResult | null | undefined) : null
  const tone = j.running ? 'bg-surface' : j.error || sync?.errors.length ? 'bg-blocked-tint' : 'bg-ok-tint'
  return (
    <div role="status" className={`flex items-center gap-4 rounded-lg border border-line px-4 py-3 text-sm ${tone}`}>
      {j.running ? (
        <>
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
          <div className="flex min-w-0 grow flex-col gap-0.5">
            <span className="font-medium">
              {RUNNING[j.kind ?? ''] ?? 'Проучват се нови продукти'}
              {j.kind === 'sync' ? ` · ${label(j.store)}` : ''} · {j.stage_label}
              {j.stage === 'research'
                ? ` · ${j.done} от ${j.total}`
                : j.kind === 'sync' && j.done
                  ? ` · ${j.done}`
                  : '…'}
            </span>
            <span className="text-xs text-ink-2">
              {j.kind === 'sync'
                ? 'Може да продължиш работа. Каквото си променил тук и още не е качено, се запазва.'
                : `${plural(j.total, 'продукт', 'продукта')}. Не пускай deploy, докато върви: рестартът я спира.`}
            </span>
          </div>
          {j.kind !== 'sync' && (
            <Button asChild>
              <Link to={`/batches/new?job=${j.id}`}>Виж прогреса</Link>
            </Button>
          )}
        </>
      ) : sync ? (
        <>
          <span className="flex min-w-0 grow flex-col gap-0.5">
            {sync.stores.length > 0 && (
              <span className="font-medium">
                Изтеглени от Shopify:{' '}
                {sync.stores.map((s) => `${label(s.store)} ${plural(s.products, 'продукт', 'продукта')}`).join(', ')}
              </span>
            )}
            {sync.errors.map((e) => (
              <span key={e} className="text-blocked-text">
                {e}
              </span>
            ))}
          </span>
          <Button variant="ghost" size="icon" aria-label="Скрий" onClick={dismiss}>
            <X size={16} />
          </Button>
        </>
      ) : j.error ? (
        <>
          <span className="min-w-0 grow text-blocked-text">Последната задача спря: {j.error}</span>
          <Button variant="ghost" size="icon" aria-label="Скрий" onClick={dismiss}>
            <X size={16} />
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 grow font-medium">
            Новите продукти са готови{j.cost_usd != null ? ` · $${j.cost_usd.toFixed(2)}` : ''}
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
