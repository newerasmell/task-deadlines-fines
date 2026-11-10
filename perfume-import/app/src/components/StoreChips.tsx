import { Link } from 'react-router'
import type { CatalogEntry, CatalogState, CatalogStore } from '../lib/api'
import { cn } from '../lib/cn'

// One small square per store: what the product is in that store. A square links to that store's copy.

const STATE_TEXT: Record<CatalogState, string> = {
  live: 'На живо',
  diff: 'Има промени за качване',
  ready: 'Готов, не е качен',
  bad: 'Нужна е намеса',
  none: 'Няма го в магазина',
}

const LOOK: Record<CatalogState, string> = {
  live: 'bg-[#2e7d4f1a] text-ok shadow-[inset_3px_0_0_var(--color-ok)]',
  diff: 'bg-warning-tint text-warning-text shadow-[inset_3px_0_0_var(--color-warning)]',
  ready: 'bg-suggested-tint text-suggested-text shadow-[inset_3px_0_0_var(--color-suggested)]',
  bad: 'bg-blocked-tint text-blocked-text shadow-[inset_3px_0_0_var(--color-blocked)]',
  none: 'border border-dashed border-muted text-muted',
}

function storeCode(store: CatalogStore): string {
  return store.country ?? store.key.slice(0, 2).toUpperCase()
}

export function StoreChip({ state, code, className }: { state: CatalogState; code: string; className?: string }) {
  return (
    <span
      className={cn(
        'tabular inline-flex h-[22px] w-[30px] shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold',
        LOOK[state],
        className,
      )}
    >
      {code}
    </span>
  )
}

export function StoreChips({
  entry,
  stores,
  current,
}: {
  entry: CatalogEntry
  stores: CatalogStore[]
  current?: number
}) {
  return (
    <span className="inline-flex flex-wrap gap-0.5">
      {stores.map((s) => {
        const at = entry.stores[s.key]
        const state = at?.state ?? 'none'
        const title = `${s.label}: ${STATE_TEXT[state]}`
        if (!at) return <StoreChip key={s.key} state={state} code={storeCode(s)} className="cursor-default" />
        return (
          <Link
            key={s.key}
            to={`/batches/${at.batch_id}/products/${at.product_id}`}
            title={title}
            aria-label={title}
            aria-current={current === at.product_id ? 'page' : undefined}
            onClick={(e) => e.stopPropagation()}
            className="rounded-[4px] no-underline aria-[current=page]:outline aria-[current=page]:outline-2 aria-[current=page]:outline-offset-1 aria-[current=page]:outline-ink"
          >
            <StoreChip state={state} code={storeCode(s)} />
          </Link>
        )
      })}
    </span>
  )
}

export function StateLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {(Object.keys(STATE_TEXT) as CatalogState[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5">
          <StoreChip state={s} code="" className="h-3.5 w-5" />
          {STATE_TEXT[s]}
        </span>
      ))}
    </div>
  )
}
