import { useQuery } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { AppNav } from '../components/AppNav'
import { Button } from '../components/ui/button'
import { api, type QuickItem, type QuickRow, type StoreRow } from '../lib/api'
import { cn } from '../lib/cn'
import { plural } from '../lib/labels'
import { useStores } from '../lib/queries'

// Нов продукт: a name with its volume, an EAN and a price in euros, nothing else. The check is free and shows
// what will be read; „Създай“ researches the product, writes every store's text by its template and sets the
// price in each store's currency; the product then opens for a look and publishing.

type Mode = 'one' | 'many'
const EMPTY: QuickItem = { name: '', ean: '', price: '', compare: '' }

/** „Име; EAN; цена; стара цена“ per line, or columns pasted from Excel. */
function parseMany(text: string): QuickItem[] {
  return text
    .split('\n')
    .map((line) => line.split(line.includes('\t') ? '\t' : ';').map((c) => c.trim()))
    .filter((c) => c[0])
    .map(([name = '', ean = '', price = '', compare = '']) => ({ name, ean, price, compare }))
}

function code(s: StoreRow): string {
  return s.country ?? s.key.slice(0, 2).toUpperCase()
}

export function QuickNewScreen() {
  const stores = useStores()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const jobId = params.get('job')
  const [mode, setMode] = useState<Mode>('one')
  const [one, setOne] = useState<QuickItem>(EMPTY)
  const [many, setMany] = useState('')
  const [picked, setPicked] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const ready = useMemo(() => (stores.data ?? []).filter((s) => s.state === 'active'), [stores.data])
  const group = ready[0]?.group ?? null
  const choices = ready.filter((s) => s.group === group)
  const chosen = picked ?? choices.map((s) => s.key)
  const items = useMemo(() => (mode === 'one' ? (one.name.trim() ? [one] : []) : parseMany(many)), [mode, one, many])

  // The free check, a moment after the last key.
  const [debounced, setDebounced] = useState({ items, chosen })
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ items, chosen }), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items), chosen.join(',')])
  const check = useQuery({
    queryKey: ['quick-check', debounced],
    queryFn: () => api.quickCheck(debounced.items, debounced.chosen),
    enabled: debounced.items.length > 0 && debounced.chosen.length > 0 && !jobId,
    retry: false,
    placeholderData: (previous) => previous,
  })

  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.running === false ? false : 3000),
  })
  useEffect(() => {
    const j = job.data
    if (j && !j.running && !j.error && j.batch_id && !j.result) navigate(`/batches/${j.batch_id}`)
  }, [job.data, navigate])

  const good = check.data?.rows.filter((r) => !r.problems.length).length ?? 0
  const start = async () => {
    setError(null)
    setStarting(true)
    try {
      const { job_id } = await api.quickStart(items, chosen)
      setParams({ job: job_id })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }
  const toggle = (key: string) => setPicked(chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key])

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-4 border-b border-line px-7">
        <AppNav />
      </header>
      <main className="flex max-w-[860px] flex-col gap-5 px-7 py-6">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-lg font-semibold">Нов продукт</h1>
          <p className="m-0 text-sm text-ink-2">
            Напиши какво знаеш. AI намира нотките, описанието и снимката, после всичко се прави по шаблона на всеки
            магазин и цената се превръща във валутата му.
          </p>
        </div>

        {jobId ? (
          <Progress jobId={jobId} onAgain={() => setParams({})} />
        ) : (
          <>
            <div role="tablist" className="flex gap-1 border-b border-line">
              {(
                [
                  ['one', 'Един продукт'],
                  ['many', 'Много наведнъж'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={mode === key}
                  onClick={() => setMode(key)}
                  className="-mb-px border-0 border-b-2 border-transparent bg-transparent px-3 py-2 text-sm text-ink-2 aria-selected:border-accent aria-selected:font-semibold aria-selected:text-ink"
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === 'one' ? (
              <div className="flex flex-col gap-4">
                <Field label="Продукт" hint="Марка, име, концентрация и обем. Напиши TESTER, ако е тестер.">
                  <input
                    autoFocus
                    value={one.name}
                    onChange={(e) => setOne({ ...one, name: e.target.value })}
                    placeholder="Versace Eros EDT 100 ml"
                    className="h-10 w-full rounded-md border border-line px-3 text-base outline-none focus:border-accent"
                  />
                </Field>
                <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
                  <Field label="EAN" hint="Ако не го знаеш, AI предлага EAN от източниците.">
                    <input
                      value={one.ean}
                      inputMode="numeric"
                      onChange={(e) => setOne({ ...one, ean: e.target.value })}
                      className="tabular h-10 w-full rounded-md border border-line px-3 outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="Цена в €" hint="CZK, HUF, PLN… се изчисляват сами.">
                    <input
                      value={one.price}
                      inputMode="decimal"
                      onChange={(e) => setOne({ ...one, price: e.target.value })}
                      className="tabular h-10 w-full rounded-md border border-line px-3 outline-none focus:border-accent"
                    />
                  </Field>
                  <Field label="Стара цена в €">
                    <input
                      value={one.compare}
                      inputMode="decimal"
                      onChange={(e) => setOne({ ...one, compare: e.target.value })}
                      className="tabular h-10 w-full rounded-md border border-line px-3 outline-none focus:border-accent"
                    />
                  </Field>
                </div>
              </div>
            ) : (
              <Field
                label="Продукти, по един на ред"
                hint="Име; EAN; цена €; стара цена €. Може да поставиш колони от Excel в същия ред."
              >
                <textarea
                  autoFocus
                  value={many}
                  onChange={(e) => setMany(e.target.value)}
                  rows={8}
                  placeholder={'Versace Eros EDT 100 ml; 8011003809219; 69; 99\nDior Sauvage EDP 60 ml; ; 79; 115'}
                  className="tabular w-full rounded-md border border-line p-3 text-sm outline-none focus:border-accent"
                />
              </Field>
            )}

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">В кои магазини</span>
              {stores.isPending ? (
                <span className="text-sm text-ink-2">Зареждам магазините…</span>
              ) : !choices.length ? (
                <span className="text-sm text-ink-2">
                  Още няма магазин с шаблон. Качи каталога на магазин в <Link to="/stores">Магазини</Link>.
                </span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {choices.map((s) => (
                    <Button
                      key={s.key}
                      variant="chip"
                      size="sm"
                      aria-pressed={chosen.includes(s.key)}
                      onClick={() => toggle(s.key)}
                    >
                      <span className="tabular text-xs font-semibold text-ink-2">{code(s)}</span>
                      {s.label.split(' (')[0]}
                    </Button>
                  ))}
                </div>
              )}
            </div>

            {check.data && items.length > 0 && <Preview rows={check.data.rows} />}
            {check.error && <div className="text-sm text-blocked-text">{(check.error as Error).message}</div>}
            {error && <div className="text-sm text-blocked-text">{error}</div>}
            {check.data && !check.data.api_key && (
              <div className="text-sm text-blocked-text">
                Няма ключ за Claude на сървъра; без него продуктът не може да се проучи.
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <Button
                variant="primary"
                size="lg"
                disabled={!good || !chosen.length || starting || check.isFetching || !check.data?.api_key}
                onClick={start}
              >
                {good > 1 ? `Създай ${good} продукта` : 'Създай'}
              </Button>
              {check.data && good > 0 && (
                <span className="text-sm text-ink-2">
                  около {Math.max(1, Math.round(good * 0.5))} мин · до ${check.data.estimate.total.toFixed(2)} ·{' '}
                  {plural(chosen.length, 'магазин', 'магазина')}
                </span>
              )}
              <div className="grow" />
              <Link to="/batches/new" className="text-sm no-underline">
                Таблица, CSV или задълбочено проучване
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-2">{hint}</span>}
    </label>
  )
}

function Preview({ rows }: { rows: QuickRow[] }) {
  return (
    <ul className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-line p-0">
      {rows.map((r) => (
        <li key={r.line} className="flex flex-col gap-0.5 border-b border-line-2 px-3.5 py-2.5 text-sm last:border-b-0">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{r.name || 'Без име'}</span>
            <span className="tabular text-xs text-ink-2">
              {[
                r.ml ? `${r.ml} ml` : null,
                r.tester ? 'тестер' : null,
                r.ean ? `EAN ${r.ean}` : 'без EAN: AI ще предложи',
                r.price_eur ? `${r.price_eur.toFixed(2)} €` : 'без цена: качва се като чернова',
                r.compare_eur ? `стара ${r.compare_eur.toFixed(2)} €` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
          {r.problems.map((p) => (
            <span key={p} className="text-xs text-blocked-text">
              {p}
            </span>
          ))}
          {r.exists.length > 0 && r.exists_at && (
            <span className="text-xs text-warning-text">
              Вече го има в {r.exists.length === 1 ? '1 магазин' : `${r.exists.length} магазина`}.{' '}
              <Link to={`/batches/${r.exists_at.batch_id}/products/${r.exists_at.product_id}`}>Отвори го</Link> вместо
              да създаваш нов.
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

const STEPS = [
  ['research', 'Проучване: нотки, семейство, източници'],
  ['images', 'Снимка по размерите на всеки магазин'],
  ['texts', 'Описанията за всеки магазин'],
  ['fields', 'Полета по шаблона на магазина'],
  ['saving', 'Запис и цени във валутата на магазина'],
] as const

function Progress({ jobId, onAgain }: { jobId: string; onAgain: () => void }) {
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId),
    refetchInterval: (q) => (q.state.data?.running === false ? false : 3000),
  })
  const j = job.data
  if (job.isError)
    return (
      <div className="flex flex-col items-start gap-3 text-sm">
        <span className="text-blocked-text">{(job.error as Error).message}</span>
        <Button onClick={onAgain}>Нов продукт</Button>
      </div>
    )
  if (!j) return <div className="text-sm text-ink-2">Зареждам…</div>
  const at = STEPS.findIndex(([k]) => k === j.stage)
  const prices = (j.result as Record<string, string> | null | undefined)?.['Цени']
  return (
    <div className="flex flex-col gap-4">
      <ol className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-line p-0">
        {STEPS.map(([key, label], i) => {
          const done = !j.running ? !j.error : i < at
          const now = j.running && i === at
          return (
            <li
              key={key}
              className="flex items-center gap-3 border-b border-line-2 px-3.5 py-2.5 text-sm last:border-b-0"
            >
              <span
                className={cn(
                  'flex size-[18px] shrink-0 items-center justify-center rounded-full text-white',
                  done ? 'bg-ok' : now ? 'animate-pulse bg-accent' : 'bg-line',
                )}
                aria-hidden
              >
                {done && <Check size={12} />}
              </span>
              <span className={cn(!done && !now && 'text-ink-2')}>
                {label}
                {now && key === 'research' && j.total > 1 ? ` · ${j.done} от ${j.total}` : ''}
              </span>
            </li>
          )
        })}
      </ol>
      {j.running ? (
        <span className="text-xs text-ink-2">
          Може да затвориш страницата: продуктът ще се появи в „Продукти“, когато е готов.
        </span>
      ) : j.error ? (
        <div className="flex flex-col items-start gap-3 text-sm">
          <span className="text-blocked-text">Спря: {j.error}</span>
          <Button onClick={onAgain}>Опитай отново</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {prices && <span className="text-warning-text">Цените не се зададоха навсякъде: {prices}</span>}
          {j.batch_id && (
            <Button variant="primary" asChild>
              <Link to={`/batches/${j.batch_id}`}>Отвори продукта</Link>
            </Button>
          )}
          <Button onClick={onAgain}>Още един продукт</Button>
        </div>
      )}
    </div>
  )
}
