import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type StoreRow } from '../lib/api'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

// „Свържи магазин“: the Shopify address and the app's access, nothing to upload. The products are read from
// Shopify and the store's template is learned from them; the job banner then links to the template to accept.

const field = 'flex flex-col gap-1 text-sm font-medium'
const input = 'h-9 rounded-md border border-line bg-canvas px-2.5 text-sm font-normal text-ink'
const COUNTRIES = [
  'GR',
  'HR',
  'CZ',
  'HU',
  'PL',
  'SI',
  'SK',
  'CY',
  'BG',
  'RO',
  'LT',
  'LV',
  'EE',
  'DE',
  'AT',
  'IT',
  'US',
  'CA',
]
const LANGUAGES: [string, string][] = [
  ['el', 'гръцки'], ['hr', 'хърватски'], ['cs', 'чешки'], ['hu', 'унгарски'], ['pl', 'полски'], ['sl', 'словенски'],
  ['sk', 'словашки'], ['bg', 'български'], ['ro', 'румънски'], ['lt', 'литовски'], ['lv', 'латвийски'],
  ['et', 'естонски'], ['de', 'немски'], ['it', 'италиански'], ['en', 'английски'],
] // prettier-ignore
const CURRENCIES = ['EUR', 'CZK', 'HUF', 'PLN', 'BGN', 'RON', 'USD', 'CAD']

export function ConnectStore({ store, groups, onClose }: { store?: StoreRow; groups: string[]; onClose: () => void }) {
  const client = useQueryClient()
  const [form, setForm] = useState({
    name: '',
    group: store?.group ?? groups[0] ?? '',
    shop: store?.shop ?? '',
    country: '',
    language: '',
    currency: '',
    client_id: '',
    client_secret: '',
    token: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const hasAccess = !!store?.access_set
  const isNew = !store

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.connectStore({ ...form, store: store?.key })
      void client.invalidateQueries({ queryKey: ['job', 'latest'] })
      void client.invalidateQueries({ queryKey: ['stores'] })
      onClose()
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
      title={store ? `Свържи ${store.label.split(' (')[0]}` : 'Добави магазин'}
      description="Въведи адреса на магазина в Shopify и достъпа от приложението в Shopify Dev Dashboard. Продуктите се четат директно оттам и шаблонът на магазина се научава от тях; после го потвърждаваш. Нищо не се качва ръчно."
      footer={
        <>
          <Button onClick={onClose}>Откажи</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy
              ? 'Проверявам достъпа…'
              : store?.state === 'active'
                ? 'Научи шаблона наново'
                : 'Свържи и научи шаблона'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {isNew && (
          <div className="grid grid-cols-2 gap-3">
            <label className={field}>
              Име на магазина
              <input className={input} value={form.name} onChange={set('name')} placeholder="Luxaromi" />
            </label>
            <label className={field}>
              Група
              <select className={input} value={form.group} onChange={set('group')}>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g.replace('group-', 'Група ')}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              Държава
              <select className={input} value={form.country} onChange={set('country')}>
                <option value="">—</option>
                {COUNTRIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className={field}>
              Език
              <select className={input} value={form.language} onChange={set('language')}>
                <option value="">—</option>
                {LANGUAGES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className={field}>
              Валута
              <select className={input} value={form.currency} onChange={set('currency')}>
                <option value="">—</option>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <label className={field}>
          Shopify адрес
          <input className={input} value={form.shop} onChange={set('shop')} placeholder="ime.myshopify.com" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={field}>
            Client ID
            <input className={input} value={form.client_id} onChange={set('client_id')} autoComplete="off" />
          </label>
          <label className={field}>
            Client secret
            <input
              className={input}
              type="password"
              value={form.client_secret}
              onChange={set('client_secret')}
              autoComplete="new-password"
            />
          </label>
        </div>
        <span className="text-xs text-ink-2">
          {hasAccess
            ? 'Достъпът вече е въведен; остави полетата празни, за да го запазиш.'
            : 'Ключовете се пазят криптирани и не се показват повече.'}{' '}
          Нужни права: read_products, write_products, write_files, read_publications, write_publications.
        </span>
        {error && <span className="text-sm text-blocked-text">{error}</span>}
      </div>
    </Dialog>
  )
}
