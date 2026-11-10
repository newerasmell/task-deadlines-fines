import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api, type SendStore } from '../lib/api'
import { cn } from '../lib/cn'
import { useStores } from '../lib/queries'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

// „Качи в магазините“: the product in every store at once. Per store it says what will happen: the changed
// fields of a live product are written, a product prepared here is created, a store without it can have it
// made; what waits on a person is said with a link to that store's copy.

const ACTIONABLE = new Set(['update', 'create', 'missing'])

export function SendButton({ productId }: { productId: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="primary" size="lg" onClick={() => setOpen(true)}>
        Качи в магазините
      </Button>
      {open && <SendDialog productId={productId} onClose={() => setOpen(false)} />}
    </>
  )
}

function SendDialog({ productId, onClose }: { productId: number; onClose: () => void }) {
  const client = useQueryClient()
  const stores = useStores()
  const plan = useQuery({ queryKey: ['send', productId], queryFn: () => api.sendPlan(productId) })
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [status, setStatus] = useState<'draft' | 'active'>('active')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Record<string, string> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rows = plan.data?.stores ?? []
  const chosen =
    picked ?? new Set(rows.filter((s) => s.action === 'update' || s.action === 'create').map((s) => s.store))
  const label = (key: string) => stores.data?.find((s) => s.key === key)?.label.split(' (')[0] ?? key
  const code = (key: string) => stores.data?.find((s) => s.key === key)?.country ?? key.slice(0, 2).toUpperCase()
  const toggle = (key: string) => {
    const next = new Set(chosen)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setPicked(next)
  }
  const creates = rows.some((s) => chosen.has(s.store) && (s.action === 'create' || s.action === 'missing'))
  const makes = rows.filter((s) => chosen.has(s.store) && s.action === 'missing').length

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.send(productId, [...chosen], status)
      setDone(r.done)
      setPicked(new Set())
      client.setQueryData(['send', productId], r.plan)
      for (const key of [['batch'], ['catalog'], ['product-catalog'], ['live'], ['job', 'latest']])
        void client.invalidateQueries({ queryKey: key })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Качи в магазините"
      description="Във всеки магазин отива само това, което е прието. Продуктите, които вече са в магазина, се обновяват само в променените полета."
      footer={
        <>
          {creates && (
            <span className="mr-auto flex items-center gap-3 text-sm">
              Новите в магазина:
              {(['active', 'draft'] as const).map((s) => (
                <label key={s} className="flex items-center gap-1.5">
                  <input type="radio" checked={status === s} onChange={() => setStatus(s)} />
                  {s === 'active' ? 'активни' : 'чернови'}
                </label>
              ))}
            </span>
          )}
          <Button onClick={onClose}>{done ? 'Затвори' : 'Откажи'}</Button>
          <Button variant="primary" disabled={!chosen.size || busy} onClick={() => void send()}>
            {busy ? 'Качвам…' : chosen.size === 1 ? 'Качи в 1 магазин' : `Качи в ${chosen.size} магазина`}
          </Button>
        </>
      }
    >
      {plan.isPending ? (
        <span className="text-sm text-ink-2">Проверявам магазините…</span>
      ) : plan.isError ? (
        <span className="text-sm text-blocked-text">{(plan.error as Error).message}</span>
      ) : (
        <ul className="m-0 flex max-h-[55vh] list-none flex-col overflow-y-auto rounded-md border border-line p-0">
          {rows.map((s) => (
            <Row
              key={s.store}
              s={s}
              code={code(s.store)}
              label={label(s.store)}
              checked={chosen.has(s.store)}
              onToggle={() => toggle(s.store)}
              result={done?.[s.store]}
              onOpen={onClose}
            />
          ))}
        </ul>
      )}
      {makes > 0 && (
        <span className="text-xs text-ink-2">
          В {makes === 1 ? '1 магазин' : `${makes} магазина`} продуктът се прави от магазините, в които вече е на живо:
          нотките, семейството, пола и снимката се вземат оттам и се превеждат, текстът се пише по шаблона на магазина
          (около минута, ≈ $0.02 на магазин). Каквото два магазина казват еднакво, е прието; останалото прегледай и го
          качи оттук.
        </span>
      )}
      {error && <span className="text-sm text-blocked-text">{error}</span>}
    </Dialog>
  )
}

function Row({
  s,
  code,
  label,
  checked,
  onToggle,
  result,
  onOpen,
}: {
  s: SendStore
  code: string
  label: string
  checked: boolean
  onToggle: () => void
  result?: string
  onOpen: () => void
}) {
  const can = ACTIONABLE.has(s.action)
  const text =
    s.action === 'update'
      ? `Обновява: ${s.changes.join(', ')}`
      : s.action === 'create'
        ? 'Създава се в магазина'
        : s.action === 'missing'
          ? 'Няма го в магазина: създай го'
          : s.action === 'wait'
            ? `Чака: ${s.reason}`
            : (s.reason ?? 'Няма какво да се качи')
  return (
    <li className="flex items-start gap-3 border-b border-line-2 px-3 py-2.5 text-sm last:border-b-0">
      <input
        type="checkbox"
        className="mt-0.5"
        disabled={!can}
        checked={checked}
        onChange={onToggle}
        aria-label={`${label}: ${text}`}
      />
      <span className="tabular w-6 shrink-0 text-xs font-semibold text-ink-2">{code}</span>
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className={cn('text-xs', s.action === 'wait' ? 'text-warning-text' : can ? 'text-ink-3' : 'text-ink-2')}>
          {text}
          {s.action === 'update' && s.reason ? ` · чака: ${s.reason}` : ''}
        </span>
        {s.message && <span className="text-xs text-blocked-text">Последният опит: {s.message}</span>}
        {result && <span className="text-xs text-ok">{result}</span>}
      </span>
      {s.product_id && s.batch_id && (
        <Link
          to={`/batches/${s.batch_id}/products/${s.product_id}`}
          onClick={onOpen}
          className="shrink-0 text-xs no-underline"
        >
          Отвори
        </Link>
      )}
    </li>
  )
}
