import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { FieldPanel } from '../components/FieldPanel'
import { Empty, Failure, Loading } from '../components/States'
import { StatusMark } from '../components/StatusMark'
import { Button } from '../components/ui/button'
import type { AuditItem, AuditIssue } from '../lib/api'
import { cn } from '../lib/cn'
import { display, fieldLabel, groupLabel, plural, stripHtml } from '../lib/labels'
import { useAudit, useAuditItems, useProduct, useStores } from '../lib/queries'

// Audit of an existing catalog (Audit.dc.html): findings by rule with what the system does, the products
// behind each, a fix in place, and the CSV of all fixes for Shopify's import.

const EXPLAIN: Record<string, string> = {
  blocked: 'Системата не знае коя стойност е вярната, затова само ги показва. Поправи ги тук или в Shopify.',
  fixed: 'Поправено автоматично; поправката влиза в CSV-то за Shopify. Ако е грешна, промени я.',
  warning: 'Не спира нищо. Реши дали да го поправиш; поправеното влиза в CSV-то.',
  suggested: 'Предложение за преглед: приеми го или го промени.',
}
const PRICE_RULES = new Set(['compare_at_not_above', 'compare_at_ratio', 'price_missing'])

export function AuditScreen() {
  const batchId = Number(useParams().batchId)
  const summary = useAudit(batchId)
  const stores = useStores()
  const [rule, setRule] = useState<string | null>(null)
  const [limit, setLimit] = useState(50)
  const [open, setOpen] = useState<{ productId: number; key: string } | null>(null)
  const current = rule ?? summary.data?.issues[0]?.rule ?? null
  const items = useAuditItems(batchId, current, limit)
  const opened = useProduct(open?.productId ?? null) // only this product, not the whole catalog

  if (summary.isPending) return <Loading what="одита" />
  if (summary.isError) return <Failure error={summary.error} retry={() => summary.refetch()} />
  const s = summary.data
  const store = stores.data?.find((x) => x.key === s.store)
  const issue = s.issues.find((i) => i.rule === current)
  const product = open && opened.data?.id === open.productId ? opened.data : null

  return (
    <div className="flex h-screen min-w-[1024px] flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line px-7">
        <div className="flex items-center gap-2 text-base">
          <Link to="/audits" className="text-ink-2 no-underline hover:text-ink">
            Одит на каталог
          </Link>
          <span className="text-muted">/</span>
          <span className="font-semibold">
            {store ? `${store.label.split(' (')[0]} ${store.country ?? ''}` : s.store}, {groupLabel(s.group)}
          </span>
          <span className="text-ink-2">{plural(s.products, 'продукт', 'продукта')}</span>
        </div>
        <div className="grow" />
        <Button asChild>
          <Link to={`/batches/${batchId}/grid`}>Отвори в таблица</Link>
        </Button>
        <Button variant="primary" asChild>
          <a href={`/api/batches/${batchId}/fix.csv`} download aria-disabled={!s.fix_products}>
            <Download size={16} /> CSV с поправките ({plural(s.fix_products, 'продукт', 'продукта')})
          </a>
        </Button>
      </header>

      <div className="flex min-h-0 grow">
        <section
          className={cn(
            'flex shrink-0 flex-col overflow-y-auto border-r border-line',
            open ? 'w-[360px]' : 'w-[520px] xl:w-[620px]',
          )}
        >
          <div className={cn('grid border-b border-line bg-surface text-xs font-medium text-ink-2', open ? 'grid-cols-[minmax(0,1fr)_64px]' : 'grid-cols-[minmax(0,1fr)_70px_190px]')}>
            <div className="px-5 py-2.5">Проблем</div>
            <div className="px-3 py-2.5 text-right">Брой</div>
            {!open && <div className="px-5 py-2.5">Какво прави системата</div>}
          </div>
          {s.issues.map((i) => (
            <IssueRow
              key={i.rule}
              i={i}
              compact={!!open}
              active={i.rule === current}
              onClick={() => {
                setRule(i.rule)
                setLimit(50)
                setOpen(null)
              }}
            />
          ))}
          {!s.issues.length && <Empty>Каталогът минава всички проверки.</Empty>}
        </section>

        <section className="flex min-w-0 grow flex-col gap-4 overflow-y-auto px-7 py-6">
          {issue && (
            <>
              <div className="flex flex-col gap-1">
                <h2 className="m-0 text-lg font-semibold">{issue.label}</h2>
                <span className="text-sm leading-normal text-ink-2">{EXPLAIN[issue.status]}</span>
              </div>
              {items.isError ? (
                <Failure error={items.error} retry={() => items.refetch()} />
              ) : !items.data ? (
                <Loading what="продуктите" />
              ) : (
                <>
                  <ItemsTable rule={issue.rule} items={items.data.items} onFix={(it) => setOpen({ productId: it.product_id, key: it.key })} />
                  <div className="flex items-center gap-3 text-xs text-ink-2">
                    Показани са {items.data.items.length} от {items.data.total}.
                    {items.data.items.length < items.data.total && (
                      <Button size="sm" onClick={() => setLimit(limit + 100)}>
                        Покажи още
                      </Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>

        {open && (product ? (
          <FieldPanel
            key={`${open.productId}-${open.key}`}
            batch={{
              id: batchId,
              kind: 'audit',
              name: s.name,
              group: s.group,
              created_at: s.created_at,
              author: null,
              stores: store ? [{ ...store }] : [],
              products: [product],
            }}
            product={product}
            store={s.store ?? Object.keys(product.stores)[0]}
            fieldKey={open.key}
            onClose={() => setOpen(null)}
          />
        ) : (
          <aside className="w-[400px] shrink-0 border-l border-line">
            {opened.isError ? <Failure error={opened.error} /> : <Loading what="продукта" />}
          </aside>
        ))}
      </div>
    </div>
  )
}

function IssueRow({ i, active, compact, onClick }: { i: AuditIssue; active: boolean; compact: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'grid min-h-12 w-full items-center border-0 border-b border-line-2 text-left text-sm',
        compact ? 'grid-cols-[minmax(0,1fr)_64px]' : 'grid-cols-[minmax(0,1fr)_70px_190px]',
        active ? 'bg-suggested-tint shadow-[inset_3px_0_0_var(--color-accent)]' : 'bg-canvas hover:bg-surface',
      )}
    >
      <span className="flex items-center gap-2.5 px-5">
        <StatusMark status={i.status} />
        {i.label}
      </span>
      <span className="tabular px-3 text-right">{i.fields}</span>
      {!compact && <span className="px-5 text-ink-3">{i.action}</span>}
    </button>
  )
}

function ItemsTable({ rule, items, onFix }: { rule: string; items: AuditItem[]; onFix: (i: AuditItem) => void }) {
  const prices = PRICE_RULES.has(rule)
  const cols = prices ? 'grid-cols-[minmax(0,1fr)_100px_120px_120px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_110px]'
  const text = (v: unknown) => stripHtml(v).slice(0, 140)
  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-line">
      <div className={`grid ${cols} border-b border-line bg-surface text-xs font-medium text-ink-2`}>
        <div className="px-3.5 py-2.5">Продукт</div>
        {prices ? (
          <>
            <div className="px-3.5 py-2.5 text-right">Цена</div>
            <div className="px-3.5 py-2.5 text-right">Зачеркната</div>
          </>
        ) : (
          <>
            <div className="px-3.5 py-2.5">Стойност</div>
            <div className="px-3.5 py-2.5">Преди</div>
          </>
        )}
        <div className="px-3.5 py-2.5" />
      </div>
      {items.map((it) => (
        <div key={it.field_id} className={`grid ${cols} items-center border-b border-line-2 text-sm last:border-b-0`}>
          <div className="flex min-w-0 flex-col px-3.5 py-2.5">
            <span className="truncate">{it.title}</span>
            {!prices && <span className="text-xs text-ink-2">{fieldLabel(it.key)}</span>}
          </div>
          {prices ? (
            <>
              <div className="tabular px-3.5 py-2.5 text-right">{display(it.price) || '—'}</div>
              <div
                className={cn(
                  'tabular px-3.5 py-2.5 text-right',
                  it.status === 'blocked' && 'bg-blocked-tint font-medium text-blocked-text',
                )}
              >
                {display(it.compare_at) || '—'}
              </div>
            </>
          ) : (
            <>
              <div className="min-w-0 truncate px-3.5 py-2.5" title={display(it.value)}>
                {text(it.value) || <span className="text-muted">празно</span>}
              </div>
              <div className="min-w-0 truncate px-3.5 py-2.5 text-ink-2" title={display(it.previous)}>
                {it.previous != null ? text(it.previous) : '—'}
              </div>
            </>
          )}
          <div className="px-3.5 py-1.5">
            <Button size="sm" onClick={() => onFix(it)}>
              {it.decided_by ? 'Промени' : it.status === 'fixed' ? 'Провери' : 'Поправи'}
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
