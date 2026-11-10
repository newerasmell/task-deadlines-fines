import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Batch, type Product } from '../lib/api'
import { fieldLabel } from '../lib/labels'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

// What „Попълни с AI“ can fill (db/fill.py FILLABLE and the description).
const FILLABLE = [
  'vendor',
  'name',
  'concentration',
  'gender',
  'fragrance_family',
  'top_note',
  'middle_note',
  'base_note',
  'ingredients',
  'ean',
  'body_html',
]

/** „Попълни с AI“: the product's missing or flagged facts (or only `only`), from a link or a short search, as
 * suggestions in every store. In the product header (everything missing) and in a field's panel (that field). */
export function FillMissing({ batch, product, only }: { batch: Batch; product: Product; only?: string }) {
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const missing = useQuery({
    queryKey: ['missing', product.id, product.counts],
    queryFn: () => api.missing(product.id),
  })
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
  const keys = (missing.data?.keys ?? []).filter((k) => !only || k === only)
  const text = only === 'body_html'
  const fillable = only ? FILLABLE.includes(only) : keys.length > 0
  if (!fillable && !jobId) return null

  const start = async (withLink: boolean) => {
    setError(null)
    try {
      const r = await api.fill(product.id, withLink ? url.trim() : null, only ? [only] : undefined)
      setJobId(r.job_id)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const j = job.data
  return (
    <>
      {only ? (
        <Button onClick={() => setOpen(true)}>
          {text ? 'Напиши наново с AI' : keys.length ? 'Попълни с AI или от линк' : 'Вземи наново с AI или от линк'}
        </Button>
      ) : (
        <Button size="lg" onClick={() => setOpen(true)}>
          Попълни с AI ({keys.length})
        </Button>
      )}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o && finished) setJobId(null)
        }}
        title={text ? 'Описание: напиши наново с AI' : only ? `${fieldLabel(only)}: с AI или от линк` : 'Попълни с AI'}
        description={
          text
            ? 'AI пише описанието наново от фактите и нотките на продукта, по шаблона и на езика на всеки магазин, и го записва като предложение. Ако нотките липсват или са грешни, първо ги попълни (от линк) и после пиши описанието.'
            : only
              ? `AI взема ${fieldLabel(only).toLowerCase()} от линка или с кратко търсене и го записва като предложение във всички магазини (на езика и по шаблона на всеки). Приемаш го в таблицата.`
              : `Липсва или е слабо: ${missing.data?.labels.join(', ') || '—'}. Попълват се само те, като предложения във всички магазини (нотките на езика на всеки магазин). Останалото не се пипа.`
        }
        footer={
          j ? (
            <Button onClick={() => setOpen(false)}>{j.running ? 'Скрий (продължава)' : 'Затвори'}</Button>
          ) : text ? (
            <Button variant="primary" disabled={!!jobId} onClick={() => void start(false)}>
              Напиши (≈ $0.01 на магазин)
            </Button>
          ) : (
            <>
              <Button disabled={!!jobId} onClick={() => void start(false)} title="Насочено търсене само за липсващото">
                Потърси (≈ $0.05)
              </Button>
              <Button variant="primary" disabled={!url.trim() || !!jobId} onClick={() => void start(true)}>
                Вземи от линка (≈ $0.02)
              </Button>
            </>
          )
        }
      >
        {!j && text ? null : !j ? (
          <label className="flex flex-col gap-1.5 text-sm text-ink-2">
            Линк към продукта (Fragrantica, Notino, сайта на марката…)
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.fragrantica.com/perfume/…"
              className="h-9 rounded-md border border-line bg-canvas px-2.5 text-sm text-ink"
            />
          </label>
        ) : j.running ? (
          <span className="text-sm text-ink-2">{j.stage_label}… обикновено под минута.</span>
        ) : j.error ? (
          <span className="text-sm text-blocked-text">{j.error}</span>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-ok">
              Готово{j.cost_usd != null ? ` · $${j.cost_usd.toFixed(3)}` : ''}. Прегледай предложенията в таблицата.
            </span>
            {Object.entries(j.result ?? {}).map(([k, v]) => (
              <span key={k} className={v === 'не е намерено' ? 'text-ink-2' : 'text-ink'}>
                {fieldLabel(k)}: {v}
              </span>
            ))}
          </div>
        )}
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </Dialog>
    </>
  )
}
