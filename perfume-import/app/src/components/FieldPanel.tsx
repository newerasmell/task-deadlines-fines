import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Batch, FieldRecord, Product, Status } from '../lib/api'
import { cn } from '../lib/cn'
import { display, fieldLabel, host, LOCALIZED, storeShort, stripHtml } from '../lib/labels'
import { useDecide, useReplaceImage, useSyncNotes, useVocab } from '../lib/queries'
import { TAG_TEXT, TINT } from '../lib/status'
import { Button } from './ui/button'

// Field panel (SPEC §8.3, Main.dc.html): value, origin, confidence, sources, alternatives, previous value;
// Accept (A), Edit (E), pick an alternative; Esc closes.

const SHARED = new Set(['vendor', 'name', 'concentration', 'gender', 'fragrance_family', 'ingredients', 'ean', 'sku', 'image'])
const ORIGIN: Record<FieldRecord['origin'], string> = {
  input: 'от входа',
  template: 'по шаблона на групата',
  vocab: 'от речника',
  ai_research: 'от проучването',
  ai_generated: 'написано от AI',
  auto_fix: 'автоматична поправка',
}

function headline(f: FieldRecord): string {
  if (f.decided_by && f.status === 'ok') return `Решено от ${f.decided_by}`
  const confidence = f.confidence != null ? ` · сигурност ${Math.round(f.confidence * 100)}%` : ''
  const byStatus: Record<Status, string> = {
    ok: `Готово · ${ORIGIN[f.origin]}`,
    suggested: `${f.origin === 'ai_generated' ? 'Текст от AI' : 'Предложение от AI'}${confidence}`,
    fixed: 'Автоматично поправено',
    warning: 'Внимание',
    blocked: 'Спряно: трябва поправка',
  }
  return byStatus[f.status]
}

export function FieldPanel({
  batch,
  product,
  store,
  fieldKey,
  startEditing = false,
  onClose,
}: {
  batch: Batch
  product: Product
  store: string
  fieldKey: string
  startEditing?: boolean
  onClose: () => void
}) {
  const field = product.stores[store]?.fields[fieldKey]
  const decide = useDecide(batch.id)
  const syncNotes = useSyncNotes(batch.id)
  const isNotes = ['top_note', 'middle_note', 'base_note'].includes(fieldKey)
  const vocab = useVocab(batch.group)
  // The parent remounts the panel (key) for another cell, so this state always belongs to one field.
  const [editing, setEditing] = useState(startEditing && fieldKey !== 'image')
  const [draft, setDraft] = useState(() => display(product.stores[store]?.fields[fieldKey]?.value))

  const canAccept = !!field && (field.status === 'suggested' || field.status === 'warning' || field.status === 'fixed')
  const accept = () => field && canAccept && decide.mutate({ fieldId: field.id, action: 'accept' })
  const startEdit = () => {
    if (!field) return
    setDraft(display(field.value))
    setEditing(true)
  }
  const save = () => field && decide.mutate({ fieldId: field.id, action: 'edit', value: draft }, { onSuccess: () => setEditing(false) })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select')) {
        if (e.key === 'Escape') setEditing(false)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'a' || e.key === 'A' || e.key === 'а' || e.key === 'А') {
        e.preventDefault()
        accept()
      } else if (e.key === 'e' || e.key === 'E' || e.key === 'е' || e.key === 'Е') {
        e.preventDefault()
        startEdit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!field) return null
  const storeInfo = batch.stores.find((s) => s.key === store)
  const others = batch.stores.filter((s) => s.key !== store && product.stores[s.key]?.fields[fieldKey])
  const shared = SHARED.has(fieldKey) && others.length > 0
  const controlled = vocab.data?.[fieldKey] ?? []
  const alternatives = field.alternatives.map(display).filter((a) => a && a !== display(field.value))
  const fromVocab = controlled.filter((v) => v !== display(field.value) && !alternatives.includes(v))
  const isImage = fieldKey === 'image'
  const isText = fieldKey === 'body_html' || fieldKey === 'seo_description'
  const value = isText ? stripHtml(field.value) : display(field.value)
  const original = product.media.find((m) => m.kind === 'original')

  return (
    <aside
      aria-label={`Поле ${fieldLabel(fieldKey)}`}
      className="flex w-[400px] shrink-0 flex-col border-l border-line bg-canvas shadow-[-8px_0_24px_rgba(26,29,33,0.06)]"
    >
      <div className="flex flex-col gap-1.5 border-b border-line px-5 pb-4 pt-5">
        <div className="truncate text-xs text-ink-2">
          {product.title} · {storeInfo ? `${storeInfo.label} ${storeShort(storeInfo)}` : store}
        </div>
        <div className="flex items-center justify-between">
          <h2 className="m-0 text-lg font-semibold">{fieldLabel(fieldKey)}</h2>
          <Button variant="ghost" size="icon" aria-label="Затвори (Esc)" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
      </div>

      <div className="flex grow flex-col gap-5 overflow-y-auto p-5">
        <div className={cn('flex flex-col gap-1.5 rounded-md p-3.5', field.status === 'ok' ? 'bg-surface' : TINT[field.status])}>
          <div className={cn('text-xs font-medium', field.status === 'ok' ? 'text-ok' : TAG_TEXT[field.status])}>
            {headline(field)}
          </div>
          {editing ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              {isText || value.length > 60 ? (
                <textarea
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={isText ? 10 : 4}
                  className="w-full resize-y rounded-md border border-line bg-canvas p-2.5 text-sm leading-normal text-ink"
                />
              ) : (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-canvas px-2.5 text-base text-ink"
                />
              )}
              {isNotes && (
                <Button
                  type="button"
                  variant="primary"
                  disabled={!draft.trim() || syncNotes.isPending}
                  title="Нотките в какъвто и да е вид (и с описания): AI ги свежда до имена, превежда ги и ги записва във всички магазини"
                  onClick={() =>
                    field && syncNotes.mutate({ fieldId: field.id, text: draft }, { onSuccess: () => setEditing(false) })
                  }
                >
                  {syncNotes.isPending ? 'Превеждам за всички магазини…' : 'Синхронизирай във всички магазини (превод)'}
                </Button>
              )}
              {isNotes && syncNotes.isError && (
                <span className="text-xs text-blocked-text">{(syncNotes.error as Error).message}</span>
              )}
              <div className="flex gap-2">
                <Button type="submit" variant={isNotes ? 'secondary' : 'primary'} disabled={decide.isPending}>
                  {isNotes ? 'Запази само тук' : 'Запази и провери'}
                </Button>
                <Button type="button" onClick={() => setEditing(false)}>
                  Откажи
                </Button>
              </div>
            </form>
          ) : isImage ? (
            value ? (
              <img src={value} alt={product.title} className="aspect-square w-full rounded-md border border-line bg-canvas object-contain" />
            ) : (
              <div className="text-sm text-ink-2">Няма снимка.</div>
            )
          ) : (
            <div className={cn('break-words', isText || value.length > 40 ? 'text-sm leading-normal' : 'text-lg font-semibold')}>
              {value || <span className="font-normal text-ink-2">празно</span>}
            </div>
          )}
          {field.message && <div className="text-sm leading-normal text-ink-3">{field.message}</div>}
        </div>

        {LOCALIZED.has(fieldKey) && field.value_en && (
          <div className="flex flex-col gap-1">
            <h3 className="m-0 text-sm font-semibold">Английски текст</h3>
            <div className="text-xs leading-normal text-ink-2">EN · {isText ? stripHtml(field.value_en) : field.value_en}</div>
          </div>
        )}

        {field.previous != null && display(field.previous) !== '' && display(field.previous) !== display(field.value) && (
          <div className="flex flex-col gap-1">
            <h3 className="m-0 text-sm font-semibold">Преди</h3>
            <div className="break-words text-sm text-ink-3">{isText ? stripHtml(field.previous) : display(field.previous)}</div>
          </div>
        )}

        {field.issues.length > 1 && (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Всички проверки</h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm leading-normal">
              {field.issues.map((issue, i) => (
                <li key={i} className={TAG_TEXT[issue.status]}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {field.sources.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Източници</h3>
            <div className="flex flex-col rounded-md border border-line">
              {field.sources.slice(0, 8).map((s, i) => (
                <div key={i} className="flex justify-between gap-3 border-b border-line-2 px-3 py-2.5 text-sm last:border-b-0">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="truncate">
                      {host(s.url)}
                    </a>
                  ) : (
                    <span className="truncate">{s.title}</span>
                  )}
                  <span className="shrink-0 text-ink-3">
                    {s.says ?? (s.width ? `${s.width}×${s.height} px` : s.error ? s.error : '')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {isImage && <ReplaceImage batchId={batch.id} productId={product.id} />}

        {isImage && original && (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Оригинал</h3>
            <div className="text-sm text-ink-3">
              {original.width}×{original.height} px · <a href={original.source_url ?? '#'} target="_blank" rel="noreferrer">{host(original.source_url)}</a>
            </div>
          </div>
        )}

        {(alternatives.length > 0 || fromVocab.length > 0) && (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">{alternatives.length ? 'Други стойности' : 'Други стойности от речника'}</h3>
            <div className="flex flex-wrap gap-1.5">
              {[...alternatives, ...fromVocab].map((a) => (
                <Button
                  key={a}
                  size="sm"
                  className="max-w-full"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ fieldId: field.id, action: 'pick', value: a })}
                >
                  <span className="truncate">
                    {isImage ? (a.includes(String(original?.id)) ? 'Оригиналът без сглобяване' : 'Сглобената снимка') : a}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {field.origin === 'ai_research' && (
          <a
            href={`/api/products/${product.id}/research`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-2"
          >
            Виж суровото проучване (какво върна търсенето)
          </a>
        )}

        {shared && (
          <div className="text-xs leading-relaxed text-ink-2">
            Важи за всички сайтове в партидата. Промяната тук се прилага и в {others.map(storeShort).join(', ')}.
          </div>
        )}

        {fieldKey === 'compare_at' && field.status === 'blocked' && display(field.value) !== '' && (
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Бърза поправка</h3>
            <div>
              <Button
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ fieldId: field.id, action: 'edit', value: '' })}
              >
                Махни зачеркнатата цена
              </Button>
            </div>
          </div>
        )}

        {field.status === 'warning' && !editing && (
          <div className="text-xs leading-relaxed text-ink-2">
            „Остави както е“ не променя стойността, само отбелязва, че е проверена. За поправка: Промени (E).
          </div>
        )}

        {field.status === 'blocked' && !editing && (
          <div className="text-xs leading-relaxed text-ink-2">Спряно поле не се приема: поправи го с Промени или избери друга стойност.</div>
        )}

        {decide.isError && <div className="text-sm text-blocked-text">{(decide.error as Error).message}</div>}
      </div>

      <div className="flex gap-2 border-t border-line px-5 py-4">
        <Button variant="primary" size="lg" className="grow" disabled={!canAccept || decide.isPending} onClick={accept}>
          {field.status === 'warning'
            ? 'Остави както е'
            : field.status === 'fixed'
              ? 'Приеми поправката'
              : field.status === 'suggested'
                ? 'Приеми предложението'
                : 'Прието'}{' '}
          <span className="opacity-70">A</span>
        </Button>
        <Button size="lg" disabled={editing || isImage} onClick={startEdit}>
          Промени <span className="text-ink-2">E</span>
        </Button>
      </div>
    </aside>
  )
}

/** A correct picture by link or file: it becomes the new original and is composed for every store. */
function ReplaceImage({ batchId, productId }: { batchId: number; productId: number }) {
  const [url, setUrl] = useState('')
  const replace = useReplaceImage(batchId)
  const run = (source: { url?: string; file?: File }) => replace.mutate({ productId, ...source }, { onSuccess: () => setUrl('') })
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">Смени снимката</h3>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) run({ url: url.trim() })
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… линк към снимка"
          className="h-9 min-w-0 grow rounded-md border border-line bg-canvas px-2.5 text-sm"
        />
        <Button type="submit" size="sm" disabled={!url.trim() || replace.isPending}>
          Вземи
        </Button>
      </form>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-accent">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={replace.isPending}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) run({ file })
            e.target.value = ''
          }}
        />
        или качи файл от компютъра
      </label>
      {replace.isPending && <span className="text-xs text-ink-2">Сглобявам за всички магазини… (до половин минута)</span>}
      {replace.isError && <span className="text-xs text-blocked-text">{(replace.error as Error).message}</span>}
      <span className="text-xs leading-normal text-ink-2">
        Снимката се изрязва и се поставя върху фона и размерите на всеки магазин, както при проучването. Важи за
        всички магазини на продукта; одобрението се сваля.
      </span>
    </div>
  )
}
