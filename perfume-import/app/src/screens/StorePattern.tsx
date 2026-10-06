import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import { api, type GroupScore, type StoreProfile } from '../lib/api'
import { cn } from '../lib/cn'
import { groupLabel, languageName, shortDate } from '../lib/labels'
import { rows, type Row } from '../lib/profile'
import { useProfile, useStoreMutation } from '../lib/queries'

// Store profile (StorePattern.dc.html): what detect_store learned, blue rows to confirm, which group;
// "Запази профила и пусни одит" accepts it and audits the same export.

const COLS = 'grid-cols-[150px_minmax(0,1fr)_100px_110px] xl:grid-cols-[190px_minmax(0,1fr)_130px_130px]'

export function StorePatternScreen() {
  const id = Number(useParams().profileId)
  const profile = useProfile(id)
  if (profile.isPending) return <Loading what="профила" />
  if (profile.isError) return <Failure error={profile.error} retry={() => profile.refetch()} />
  return <Pattern p={profile.data} />
}

function Pattern({ p }: { p: StoreProfile }) {
  const navigate = useNavigate()
  const proposed = p.state === 'proposed'
  const scores = p.profile.group_scores ?? []
  const [group, setGroup] = useState<string | null>(
    p.group ?? scores.find((s) => s.recommended)?.group ?? null,
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const edit = useStoreMutation(({ key, value }: { key: string; value: unknown }) => api.editProfileItem(p.id, key, value))
  const accept = useStoreMutation(() => api.acceptProfile(p.id, group))
  const reject = useStoreMutation(() => api.rejectProfile(p.id))
  const error = (edit.error ?? accept.error ?? reject.error) as Error | null
  const list = rows(p)
  const lang = String((p.profile.items.content_language as { value?: string })?.value ?? '')

  return (
    <div className="flex h-screen min-w-[1024px] flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-7 text-base">
        <Link to="/stores" className="text-ink-2 no-underline hover:text-ink">
          Магазини
        </Link>
        <span className="text-muted">/</span>
        <span className="font-semibold">{p.label}</span>
      </header>
      <div className="flex min-h-0 grow">
        <main className="flex min-w-0 grow flex-col gap-[18px] overflow-y-auto p-7">
          <div className="flex items-end gap-4">
            <div className="flex grow flex-col gap-1">
              <span className="text-sm text-ink-2">
                {p.label} · {p.profile.products} продукта в експорта · версия {p.version} от {shortDate(p.created_at)}
              </span>
              <h1 className="m-0 text-[24px] font-semibold">Профил на магазина</h1>
            </div>
            <span className="max-w-[360px] text-right text-xs text-ink-2">
              {proposed
                ? 'Профилът важи само за този магазин. Сините редове са заключения за потвърждение, оранжевите са със слабо съвпадение.'
                : p.state === 'accepted'
                  ? `Потвърден${p.decided_by ? ` от ${p.decided_by}` : ''}. За промени качи каталога отново.`
                  : 'Отхвърлен.'}
            </span>
          </div>

          {p.diff && !p.diff.first && (
            <div className="rounded-md bg-surface px-4 py-3 text-sm text-ink-3">
              {p.diff.changed.length
                ? `Спрямо потвърдената версия се промениха: ${p.diff.changed.map((c) => c.key).join(', ')}.`
                : 'Нищо не се промени спрямо потвърдената версия.'}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-line">
            <div className={`grid ${COLS} border-b border-line bg-surface text-xs font-medium text-ink-2`}>
              <div className="px-4 py-2.5">Свойство</div>
              <div className="px-4 py-2.5">Разпознато</div>
              <div className="px-4 py-2.5">Съвпадение</div>
              <div className="px-4 py-2.5" />
            </div>
            {list.map((r) => (
              <PatternRow
                key={r.key}
                r={r}
                editing={editing === r.key}
                draft={draft}
                setDraft={setDraft}
                canEdit={proposed && r.editable}
                busy={edit.isPending}
                onEdit={() => {
                  setEditing(r.key)
                  setDraft(String(r.raw ?? ''))
                }}
                onCancel={() => setEditing(null)}
                onSave={() =>
                  edit.mutate(
                    { key: r.key, value: draft.trim() },
                    { onSuccess: () => setEditing(null) },
                  )
                }
              />
            ))}
          </div>
          {error && <div className="text-sm text-blocked-text">{error.message}</div>}
        </main>

        <aside className="flex w-[320px] shrink-0 flex-col gap-[18px] overflow-y-auto border-l border-line bg-surface px-6 py-7 xl:w-[400px]">
          <h2 className="m-0 text-[15px] font-semibold">Към коя група</h2>
          <div role="radiogroup" aria-label="Група" className="flex flex-col gap-2.5">
            {scores.map((s) => (
              <GroupCard
                key={s.group ?? 'new'}
                s={s}
                selected={s.group === group && s.group !== null}
                disabled={!proposed || (!s.comparable && s.group !== null)}
                onSelect={() => setGroup(s.group)}
              />
            ))}
          </div>

          <div className="flex flex-col gap-2 text-sm leading-normal text-ink-3">
            <h3 className="m-0 text-sm font-semibold text-ink">След запазване</h3>
            <span>Новите продукти за този магазин ще се генерират точно по този профил, независимо от другите магазини в групата.</span>
            <span>Намерените грешки (пол, семейство, цени) отиват в одит на каталога.</span>
            {lang && lang !== 'en' && <span>Двойките нотки на {languageName(lang)} ще допълнят речника.</span>}
          </div>

          <div className="flex flex-col gap-2 text-sm leading-normal text-ink-3">
            <h3 className="m-0 text-sm font-semibold text-ink">Достъп до Shopify</h3>
            <ShopField store={p.store} shop={p.shop} />
            <span>
              В Render → Environment добави <code className="text-xs">{p.access_env.client_id}</code> и{' '}
              <code className="text-xs">{p.access_env.client_secret}</code> от приложението в Shopify Dev Dashboard
              (права write_products, write_files). Не ги въвеждай тук.
            </span>
          </div>

          <div className="grow" />
          {proposed ? (
            <div className="flex flex-col gap-2">
              <Button
                variant="primary"
                size="lg"
                disabled={accept.isPending || !group}
                onClick={() =>
                  accept.mutate(undefined, {
                    onSuccess: (r) => r.audit_batch_id && navigate(`/batches/${r.audit_batch_id}/audit`),
                  })
                }
              >
                {accept.isPending ? 'Записвам и пускам одита…' : group ? 'Запази профила и пусни одит' : 'Избери група'}
              </Button>
              <Button variant="ghost" disabled={reject.isPending} onClick={() => reject.mutate(undefined)}>
                Отхвърли тази версия
              </Button>
            </div>
          ) : (
            p.audit_batch_id && (
              <Button variant="primary" size="lg" asChild>
                <Link to={`/batches/${p.audit_batch_id}/audit`}>Отвори одита</Link>
              </Button>
            )
          )}
        </aside>
      </div>
    </div>
  )
}

function PatternRow({
  r,
  editing,
  draft,
  setDraft,
  canEdit,
  busy,
  onEdit,
  onCancel,
  onSave,
}: {
  r: Row
  editing: boolean
  draft: string
  setDraft: (v: string) => void
  canEdit: boolean
  busy: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: () => void
}) {
  const bg = r.kind === 'confirm' ? 'bg-suggested-tint' : r.kind === 'weak' ? 'bg-warning-tint' : 'bg-canvas'
  return (
    <div className={cn(`grid ${COLS} items-center border-b border-line-2 text-sm last:border-b-0`, bg)}>
      <div className="px-4 py-[11px] text-ink-2">{r.label}</div>
      <div className="flex min-w-0 flex-col gap-[3px] px-4 py-[11px]">
        {editing ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              onSave()
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && onCancel()}
              className="h-[30px] grow rounded-md border border-line bg-canvas px-2.5 text-sm"
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>
              Запази
            </Button>
          </form>
        ) : (
          <span className="break-words font-medium leading-normal">{r.value}</span>
        )}
        {r.note && <span className="text-xs leading-normal text-ink-2">{r.note}</span>}
      </div>
      <div className={cn('tabular px-4 py-[11px]', r.kind === 'weak' ? 'font-medium text-warning-text' : 'text-ink-3')}>{r.match}</div>
      <div className="px-4 py-2">
        {canEdit && !editing && (
          <Button size="sm" onClick={onEdit}>
            Промени
          </Button>
        )}
      </div>
    </div>
  )
}

function GroupCard({ s, selected, disabled, onSelect }: { s: GroupScore; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const isNew = s.group === null
  return (
    <button
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex flex-col gap-2 rounded-lg bg-canvas p-4 text-left',
        selected ? 'border-2 border-accent' : 'm-px border border-line',
        disabled && 'cursor-default',
      )}
    >
      <span className="flex items-baseline justify-between">
        <span className="text-md font-semibold text-ink">{s.group ? groupLabel(s.group) : s.name}</span>
        {s.recommended && <span className="text-sm font-medium text-suggested-text">препоръчано</span>}
        {s.score != null && !s.recommended && <span className="tabular text-sm text-ink-2">{Math.round(s.score * 100)}%</span>}
      </span>
      <span className="text-sm leading-normal text-ink-3">
        {isNew ? s.reasons[0] : s.comparable ? `${s.reasons.join('; ')}.` : s.reasons[0]}
      </span>
    </button>
  )
}

function ShopField({ store, shop }: { store: string; shop: string | null }) {
  const [value, setValue] = useState(shop ?? '')
  const save = useStoreMutation((v: string) => api.setShop(store, v))
  const saved = save.isSuccess && !save.isPending
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate(value)
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Shopify адрес
        <span className="flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="магазин.myshopify.com"
            className="h-9 min-w-0 grow rounded-md border border-line bg-canvas px-2.5 text-sm font-normal"
          />
          <Button type="submit" disabled={!value.trim() || save.isPending || value === shop}>
            Запази
          </Button>
        </span>
      </label>
      {save.isError && <span className="text-xs text-blocked-text">{(save.error as Error).message}</span>}
      {saved && <span className="text-xs text-ok">Адресът е запазен.</span>}
    </form>
  )
}
