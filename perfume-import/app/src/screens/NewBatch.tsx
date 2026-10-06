import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { useActor } from '../lib/actorContext'
import { api, type CheckResult, type CheckedRow, type GroupInfo, type Job } from '../lib/api'
import { cn } from '../lib/cn'
import { groupLabel, plural } from '../lib/labels'

// New batch (NewBatch.dc.html): group, stores and research mode on the left; the products pasted from Excel or
// from a CSV on the right, checked for free with the expected cost; research starts only after a confirmation
// with that cost, runs on the server, and the screen shows its progress.

const TIERS = [
  { key: 'economy', label: 'Евтино', note: 'Sonnet, до $0.125 на продукт' },
  { key: 'deep', label: 'Задълбочено', note: 'Opus, до $0.50 на продукт' },
] as const

const money = (n: number) => `$${n.toFixed(2)}`

export function NewBatchScreen() {
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups })
  if (groups.isPending) return <Loading what="групите" />
  if (groups.isError) return <Failure error={groups.error} retry={() => groups.refetch()} />
  return <NewBatch groups={groups.data} />
}

function NewBatch({ groups }: { groups: GroupInfo[] }) {
  const navigate = useNavigate()
  const { ensure } = useActor()
  const ready = groups.filter((g) => g.ready)
  const [groupKey, setGroupKey] = useState(ready[0]?.key ?? '')
  const group = groups.find((g) => g.key === groupKey)
  const [stores, setStores] = useState<string[]>(() => group?.stores.map((s) => s.key) ?? [])
  const [tier, setTier] = useState<'economy' | 'deep'>('economy')
  // "table": rows with ml, EAN and prices (Excel / CSV); "names": one product name per line, the rest researched.
  const [mode, setMode] = useState<'table' | 'names'>('table')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [cleared, setCleared] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [starting, setStarting] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [typed, setTyped] = useState(text)
  const picker = useRef<HTMLInputElement>(null)

  // Typing waits a moment before the (free) check; a picked file is checked at once.
  useEffect(() => {
    const timer = setTimeout(() => setTyped(text), 300)
    return () => clearTimeout(timer)
  }, [text])

  const form = useMemo(() => {
    const f = new FormData()
    f.append('group', groupKey)
    f.append('stores', stores.join(','))
    f.append('tier', tier)
    f.append('text', typed)
    f.append('mode', mode)
    return f
  }, [groupKey, stores, tier, typed, mode])

  const enabled = !!typed.trim() && !!groupKey && stores.length > 0 && !cleared
  const check = useQuery({
    queryKey: ['check', groupKey, stores.join(','), tier, typed, mode],
    queryFn: () => api.checkBatch(form),
    enabled,
    retry: false,
  })
  const result: CheckResult | null = enabled ? (check.data ?? null) : null
  const checking = enabled && check.isFetching
  const checkError = startError ?? (enabled && check.isError ? (check.error as Error).message : null)

  /** The stores that have prices in the pasted or uploaded rows (a price_<store> column with values). */
  const storesFromHeader = (content: string) => {
    const lines = content.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) return
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : ';'
    const header = lines[0].split(sep).map((c) => c.trim())
    const rows = lines.slice(1).map((l) => l.split(sep))
    const priced =
      group?.stores
        .map((s) => s.key)
        .filter((k) => {
          const i = header.indexOf(`price_${k}`)
          return i >= 0 && rows.some((r) => (r[i] ?? '').trim())
        }) ?? []
    if (priced.length) setStores(priced)
  }

  const pickGroup = (key: string) => {
    setGroupKey(key)
    setStores(groups.find((g) => g.key === key)?.stores.map((s) => s.key) ?? [])
  }

  const start = async () => {
    if (!(await ensure())) return
    setStarting(true)
    setStartError(null)
    try {
      const r = await api.startBatch(form)
      setJobId(r.job_id)
      setConfirm(false)
    } catch (e) {
      setStartError((e as Error).message)
      setConfirm(false)
    } finally {
      setStarting(false)
    }
  }

  if (jobId) return <Progress jobId={jobId} onDone={(id) => navigate(`/batches/${id}`)} />

  const shownStores = group?.stores.filter((s) => stores.includes(s.key)) ?? []
  const problems = result?.rows.filter((r) => r.problems.length) ?? []
  const est = result?.estimate

  return (
    <div className="flex h-screen min-w-[1024px] flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-7 text-base">
        <Link to="/" className="text-ink-2 no-underline hover:text-ink">
          Партиди
        </Link>
        <span className="text-muted">/</span>
        <span className="font-semibold">Нова партида</span>
      </header>
      <div className="flex min-h-0 grow">
        <section className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-r border-line bg-surface p-7 xl:w-[340px]">
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm font-semibold">Група</legend>
            {groups.map((g) => (
              <label
                key={g.key}
                className={cn(
                  'flex items-center gap-2.5 rounded-md bg-canvas p-3 text-base',
                  g.key === groupKey ? 'border-2 border-accent' : 'm-px border border-line',
                  !g.ready && 'text-ink-2',
                )}
              >
                <input type="radio" name="group" disabled={!g.ready} checked={g.key === groupKey} onChange={() => pickGroup(g.key)} />
                {g.ready ? g.name : groupLabel(g.key)}
                {!g.ready && <span className="text-xs">без структура</span>}
              </label>
            ))}
          </fieldset>

          {group && (
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">
                Сайтове · {stores.length} от {group.stores.length}
              </legend>
              {group.stores.map((s) => (
                <label key={s.key} className="flex items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    checked={stores.includes(s.key)}
                    onChange={(e) =>
                      setStores(e.target.checked ? group.stores.map((x) => x.key).filter((k) => k === s.key || stores.includes(k)) : stores.filter((k) => k !== s.key))
                    }
                  />
                  {s.label.split(' (')[0]}
                  <span className="text-ink-2">
                    {s.country} · {s.currency}
                  </span>
                </label>
              ))}
              <span className="text-xs leading-normal text-ink-2">Всеки сайт добавя колона за цена във валутата си.</span>
            </fieldset>
          )}

          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm font-semibold">Проучване</legend>
            {TIERS.map((t) => (
              <label key={t.key} className="flex items-start gap-2.5 text-base">
                <input type="radio" name="tier" className="mt-1" checked={tier === t.key} onChange={() => setTier(t.key)} />
                <span className="flex flex-col">
                  {t.label}
                  <span className="text-xs text-ink-2">{t.note}</span>
                </span>
              </label>
            ))}
            <span className="text-xs leading-normal text-ink-2">Колоната research във файла избира режима за отделен ред.</span>
          </fieldset>
        </section>

        <section className="flex min-w-0 grow flex-col gap-4 overflow-y-auto p-7">
          <div className="flex items-end gap-3">
            <div className="flex grow flex-col gap-1">
              <h1 className="m-0 text-[22px] font-semibold">Продукти</h1>
              <span className="text-sm text-ink-2">
                {mode === 'table'
                  ? 'Постави редове от Excel или качи CSV. Останалото попълва системата.'
                  : 'По един продукт на ред, с обема. AI прави всичко останало по шаблона на всеки магазин, без цени.'}
              </span>
            </div>
            <input
              ref={picker}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                setFileName(f.name)
                const content = await f.text()
                storesFromHeader(content)
                setText(content)
                setTyped(content)
                setCleared(false)
                e.target.value = ''
              }}
            />
            <div className="flex gap-0.5" role="tablist" aria-label="Как се въвеждат продуктите">
              {(
                [
                  ['table', 'Таблица'],
                  ['names', 'Само имена'],
                ] as const
              ).map(([key, label]) => (
                <Button
                  key={key}
                  role="tab"
                  aria-selected={mode === key}
                  variant={mode === key ? 'dark' : 'secondary'}
                  onClick={() => {
                    setMode(key)
                    setText('')
                    setTyped('')
                    setFileName(null)
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
            {mode === 'table' && <Button onClick={() => picker.current?.click()}>Качи CSV</Button>}
            <Button asChild>
              <a href={`/api/groups/${groupKey}/input-template.csv`} download>
                Изтегли шаблон
              </a>
            </Button>
          </div>

          {!result ? (
            <label className="flex flex-col gap-2 text-sm text-ink-2">
              {mode === 'names'
                ? 'Имена на продукти, по един на ред: обем задължително, „TESTER“ и EAN ако ги има'
                : fileName
                  ? `Файл: ${fileName}`
                  : 'Редове от Excel, с реда със заглавията (name, ml, tester, ean, price_…)'}
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  if (mode === 'table') storesFromHeader(e.target.value)
                  setFileName(null)
                  setCleared(false)
                }}
                rows={12}
                placeholder={
                  mode === 'names'
                    ? 'Dior Sauvage EDT 100 ml\nYves Saint Laurent Libre Le Parfum 90 ml TESTER\nArmani Code Profumo EDP 110 ml 3614270581670'
                    : 'name\tml\ttester\tean\tprice_premierparfums\tprice_parfemija\nDior Sauvage EDT\t100\tне\t3348901250153\t89\t85'
                }
                className="w-full rounded-lg border border-line bg-canvas p-3 font-[inherit] text-sm text-ink"
              />
            </label>
          ) : (
            <>
              <RowsTable rows={result.rows} stores={mode === 'names' ? [] : shownStores} />
              {mode === 'names' && (
                <span className="text-sm leading-normal text-ink-2">
                  Без EAN: проучването показва EAN-а, който източниците дават за този обем, и ти го избираш в прегледа.
                  Цени не се слагат за никой от {plural(shownStores.length, 'сайт', 'сайта')}: продуктите се качват като
                  чернови и цената се задава в Shopify.
                </span>
              )}
            </>
          )}

          {checking && <span className="text-sm text-ink-2">Проверявам…</span>}
          {checkError && <span className="text-sm text-blocked-text">{checkError}</span>}
          {problems.length > 0 && (
            <div className="flex flex-col gap-1.5 text-sm">
              {problems.map((r) => (
                <span key={r.line} className="text-blocked-text">
                  Ред {r.line}: {r.problems.join(' ')}
                </span>
              ))}
            </div>
          )}
          {result && !result.api_key && (
            <div className="rounded-md bg-warning-tint px-3.5 py-2.5 text-sm text-warning-text">
              Няма ключ за Claude на сървъра. Добави ANTHROPIC_API_KEY в Render → perfume-import → Environment; проверката
              работи и без него.
            </div>
          )}

          <div className="grow" />
          <div className="flex items-center gap-3 border-t border-line pt-4">
            <span className="text-sm text-ink-2">
              {result
                ? `${result.ready} от ${result.rows.length} реда са готови.${problems.length ? ' Редовете с грешка ще бъдат пропуснати.' : ''}${est ? ` Очаквана цена ≈ ${money(est.total)}.` : ''}`
                : 'Още няма продукти.'}
            </span>
            {result && (
              <Button
                variant="ghost"
                onClick={() => {
                  setText('')
                  setTyped('')
                  setFileName(null)
                  setCleared(true)
                }}
              >
                Започни отначало
              </Button>
            )}
            <div className="grow" />
            <Button
              variant="primary"
              size="lg"
              disabled={!result?.ready || !result.api_key || checking}
              onClick={() => setConfirm(true)}
            >
              {result?.ready ? `Започни проучване на ${plural(result.ready, 'продукт', 'продукта')}` : 'Добави продукти'}
            </Button>
          </div>
        </section>
      </div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Пусни проучване на ${plural(result?.ready ?? 0, 'продукт', 'продукта')}?`}
        description={
          est ? (
            <>
              Очаквана цена ≈ {money(est.total)} общо ({est.tiers.map((t) => `${t.label}: ${t.products} × ≈ $${t.per_product.toFixed(3)}, таван $${t.ceiling.toFixed(2)} на продукт`).join('; ')}).
              Плаща се към Anthropic по ключа в Render. Отнема 5–15 минути; страницата може да се затвори.
            </>
          ) : undefined
        }
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Откажи</Button>
            <Button variant="primary" disabled={starting} onClick={start}>
              {est ? `Пусни за ≈ ${money(est.total)}` : 'Пусни'}
            </Button>
          </>
        }
      />
    </div>
  )
}

function RowsTable({ rows, stores }: { rows: CheckedRow[]; stores: GroupInfo['stores'] }) {
  const cols = ['minmax(0,1fr) 52px 64px 128px', ...stores.map(() => '72px')].join(' ')
  const bad = (r: CheckedRow, words: string[]) => r.problems.some((p) => words.some((w) => p.toLowerCase().includes(w)))
  const cell = 'px-2 py-2.5 tabular text-xs'
  const err = 'bg-blocked-tint font-medium text-blocked-text'
  return (
    <div className="shrink-0 overflow-x-auto rounded-lg border border-line">
      <div style={{ minWidth: 420 + stores.length * 72 }}>
        <div className="grid border-b border-line bg-surface text-xs font-medium text-ink-2" style={{ gridTemplateColumns: cols }}>
          <div className="px-2.5 py-2.5">Име</div>
          <div className="px-2 py-2.5 text-right">ml</div>
          <div className="px-2 py-2.5">Тестер</div>
          <div className="px-2 py-2.5">EAN</div>
          {stores.map((s) => (
            <div key={s.key} className="flex flex-col px-2 py-2 text-right leading-tight">
              <span>{s.country}</span>
              <span className="font-normal">{s.currency}</span>
            </div>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.line} className="grid min-h-10 border-b border-line-2 text-sm last:border-b-0" style={{ gridTemplateColumns: cols }}>
            <div className={cn('truncate px-2.5 py-2.5', bad(r, ['име']) && err)}>{r.name || '—'}</div>
            <div className={cn(cell, 'text-right', bad(r, ['обем', 'ml']) && err)}>{r.ml ?? '—'}</div>
            <div className={cn(cell, bad(r, ['tester']) && err)}>{r.tester ? 'да' : 'не'}</div>
            <div className={cn(cell, bad(r, ['ean']) && err, !r.ean && 'text-ink-2')}>{r.ean || 'от проучването'}</div>
            {stores.map((s) => (
              <div key={s.key} className={cn(cell, 'text-right', !r.prices[s.key] && err)}>
                {r.prices[s.key] ?? '—'}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function Progress({ jobId, onDone }: { jobId: string; onDone: (batchId: number) => void }) {
  const job = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.job(jobId),
    refetchInterval: (q) => (q.state.data && !q.state.data.running ? false : 2000),
  })
  const j: Job | undefined = job.data
  useEffect(() => {
    if (j && !j.running && j.batch_id) onDone(j.batch_id)
  }, [j, onDone])
  const pct = j && j.total ? Math.round((j.done / j.total) * 100) : 0
  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-7 text-base">
        <Link to="/" className="text-ink-2 no-underline hover:text-ink">
          Партиди
        </Link>
        <span className="text-muted">/</span>
        <span className="font-semibold">Нова партида</span>
      </header>
      <main className="flex max-w-[640px] flex-col gap-4 p-7">
        <h1 className="m-0 text-[22px] font-semibold">Проучването върви</h1>
        {job.isError ? (
          <Failure error={job.error} />
        ) : !j ? (
          <Loading what="състоянието" />
        ) : j.error ? (
          <div className="text-sm text-blocked-text">Проучването спря: {j.error}</div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <div className="flex h-1.5 grow rounded-[3px] bg-line">
                <div className="rounded-[3px] bg-accent" style={{ width: j.stage === 'research' ? `${pct}%` : '100%' }} />
              </div>
              <span className="tabular whitespace-nowrap text-sm text-ink-2">
                {j.stage_label}
                {j.stage === 'research' ? ` · ${j.done} от ${j.total}` : '…'}
              </span>
            </div>
            <span className="text-sm leading-normal text-ink-2">
              Може да затвориш страницата: партидата ще се появи в списъка, когато е готова. Описанията минават през
              Batch API и може да отнемат до 15 минути.
            </span>
          </>
        )}
        <div>
          <Button asChild>
            <Link to="/">Към партидите</Link>
          </Button>
        </div>
      </main>
    </div>
  )
}
