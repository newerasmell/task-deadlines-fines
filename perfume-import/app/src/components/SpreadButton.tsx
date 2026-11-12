import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Batch, type Product } from '../lib/api'
import { storeShort } from '../lib/labels'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

/** „Пренеси към всички“: the store a person got right becomes every other store's truth: brand, name,
 * concentration, gender, family and ingredients copied, notes translated, descriptions written again (db/fill.spread). */
export function SpreadButton({ batch, product }: { batch: Batch; product: Product }) {
  const client = useQueryClient()
  const keys = Object.keys(product.stores)
  const problems = (key: string) =>
    Object.values(product.stores[key]?.fields ?? {}).filter((f) => f.status !== 'ok' && f.status !== 'fixed').length
  const best = [...keys].sort((a, b) => problems(a) - problems(b))[0]
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<string>(best)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && !q.state.data.running ? false : 2000),
  })
  const finished = job.data && !job.data.running
  useEffect(() => {
    if (finished) void client.invalidateQueries({ queryKey: ['batch', batch.id] })
  }, [finished, client, batch.id])
  if (keys.length < 2) return null
  const label = (key: string) => {
    const s = batch.stores.find((x) => x.key === key)
    return s ? `${s.label.split(' (')[0]} · ${storeShort(s)}` : key
  }
  const start = async () => {
    setError(null)
    try {
      setJobId((await api.spread(product.id, source)).job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const j = job.data
  const others = keys.length - 1
  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        Пренеси към всички
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o && finished) setJobId(null)
        }}
        title="Пренеси от един магазин към всички"
        description="Избери магазина, в който продуктът е правилен. Марката, името, концентрацията, полът, семейството и съставките се копират, нотките се превеждат на езика на всеки магазин, а описанията се пишат наново по шаблона на всеки магазин (като предложения). Избраният магазин не се променя."
        footer={
          j ? (
            <Button onClick={() => setOpen(false)}>{j.running ? 'Скрий (продължава)' : 'Затвори'}</Button>
          ) : (
            <Button variant="primary" disabled={!!jobId} onClick={() => void start()}>
              Пренеси към {others === 1 ? '1 магазин' : `${others} магазина`} (≈ ${(0.01 * others + 0.01).toFixed(2)})
            </Button>
          )
        }
      >
        {!j ? (
          <ul className="m-0 flex list-none flex-col overflow-hidden rounded-md border border-line p-0">
            {keys.map((key) => (
              <li key={key} className="border-b border-line-2 last:border-b-0">
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <input type="radio" checked={source === key} onChange={() => setSource(key)} />
                  <span className="grow">{label(key)}</span>
                  <span className={problems(key) ? 'text-xs text-warning-text' : 'text-xs text-ok'}>
                    {problems(key) ? `${problems(key)} за решаване` : 'всичко е наред'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : j.running ? (
          <span className="text-sm text-ink-2">{j.stage_label}… обикновено под минута.</span>
        ) : j.error ? (
          <span className="text-sm text-blocked-text">{j.error}</span>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-ok">
              Готово{j.cost_usd != null ? ` · $${j.cost_usd.toFixed(3)}` : ''}. Описанията са предложения: прегледай ги
              или ги приеми с „Качи в магазините“.
            </span>
            {Object.entries((j.result as Record<string, string> | null) ?? {}).map(([k, v]) => (
              <span key={k}>
                {k}: {v}
              </span>
            ))}
          </div>
        )}
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </Dialog>
    </>
  )
}
