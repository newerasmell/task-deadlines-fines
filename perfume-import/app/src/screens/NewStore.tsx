import { FileText } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Button } from '../components/ui/button'
import { api } from '../lib/api'
import { groupLabel } from '../lib/labels'
import { useStoreMutation, useStores } from '../lib/queries'

// Add a store / update its catalog (NewStore.dc.html). The Admin API token is NOT entered here: secrets live
// only in the server's environment (CLAUDE.md), so the screen says which variables to add instead.

const COUNTRIES = ['GR', 'HR', 'CZ', 'HU', 'PL', 'SI', 'SK', 'CY', 'BG', 'RO', 'LT', 'LV', 'EE', 'DE', 'AT', 'IT', 'US', 'CA']
const LANGUAGES: [string, string][] = [
  ['el', 'гръцки'], ['hr', 'хърватски'], ['cs', 'чешки'], ['hu', 'унгарски'], ['pl', 'полски'], ['sl', 'словенски'],
  ['sk', 'словашки'], ['bg', 'български'], ['ro', 'румънски'], ['lt', 'литовски'], ['lv', 'латвийски'],
  ['et', 'естонски'], ['de', 'немски'], ['it', 'италиански'], ['en', 'английски'],
]
const CURRENCIES = ['EUR', 'CZK', 'HUF', 'PLN', 'BGN', 'RON', 'USD', 'CAD']

const field = 'flex flex-col gap-1.5 text-sm font-medium'
const input = 'h-[38px] rounded-md border border-line bg-canvas px-3 text-base font-normal text-ink'

export function NewStoreScreen() {
  const [params] = useSearchParams()
  const storeKey = params.get('store') ?? ''
  const stores = useStores()
  const existing = stores.data?.find((s) => s.key === storeKey)
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [form, setForm] = useState({ name: '', shop: '', country: '', language: '', currency: '', group: '' })
  const picker = useRef<HTMLInputElement>(null)
  const groups = [...new Set((stores.data ?? []).map((s) => s.group).filter(Boolean) as string[])].sort()
  const analyze = useStoreMutation((data: FormData) => api.analyze(data))
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  const submit = () => {
    if (!file) return
    const data = new FormData()
    data.append('file', file)
    for (const [k, v] of Object.entries(form)) data.append(k, v)
    if (storeKey) data.append('store', storeKey)
    analyze.mutate(data, { onSuccess: (r) => navigate(`/profiles/${r.profile_id}`) })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-2 border-b border-line px-7 text-base">
        <Link to="/stores" className="text-ink-2 no-underline hover:text-ink">
          Магазини
        </Link>
        <span className="text-muted">/</span>
        <span className="font-semibold">{existing ? `Каталог на ${existing.label}` : 'Нов магазин'}</span>
      </header>
      <div className="flex grow justify-center bg-surface px-7 py-10">
        <form
          className="flex w-[760px] flex-col gap-7"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[26px] font-semibold">{existing ? 'Обнови каталога' : 'Добави магазин'}</h1>
            <span className="text-base leading-normal text-ink-3">
              Качи експорт на продуктите от Shopify. От него системата прави собствен профил на магазина: език, валута,
              формат на заглавията, SKU, метаполета, стил на описанията и цените. После проверяваш профила.
            </span>
          </div>

          {!existing && (
            <section className="flex flex-col gap-[18px] rounded-lg border border-line bg-canvas p-6">
              <h2 className="m-0 text-[15px] font-semibold">Магазин</h2>
              <div className="grid grid-cols-2 gap-4">
                <label className={field}>
                  Име на магазина
                  <input required value={form.name} onChange={set('name')} placeholder="напр. Parfemija (1-HR)" className={input} />
                </label>
                <label className={field}>
                  Shopify адрес
                  <input value={form.shop} onChange={set('shop')} placeholder="магазин.myshopify.com" className={input} />
                </label>
                <label className={field}>
                  Държава
                  <select value={form.country} onChange={set('country')} className={input}>
                    <option value="">Разпознай от файла</option>
                    {COUNTRIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className={field}>
                  Език
                  <select value={form.language} onChange={set('language')} className={input}>
                    <option value="">Разпознай от файла</option>
                    {LANGUAGES.map(([c, n]) => (
                      <option key={c} value={c}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={field}>
                  Валута
                  <select value={form.currency} onChange={set('currency')} className={input}>
                    <option value="">Разпознай от файла</option>
                    {CURRENCIES.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </label>
                <label className={field}>
                  Група
                  <select value={form.group} onChange={set('group')} className={input}>
                    <option value="">Предложи група</option>
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {groupLabel(g)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="rounded-md bg-surface px-3.5 py-3 text-sm leading-normal text-ink-3">
                Достъпът до Shopify не се въвежда тук. След като профилът е готов, добави в Render → Environment Client
                ID и Secret на приложението от Shopify Dev Dashboard (имената на променливите са в профила).
              </div>
            </section>
          )}

          <section className="flex flex-col gap-3.5 rounded-lg border border-line bg-canvas p-6">
            <h2 className="m-0 text-[15px] font-semibold">Експорт на продуктите</h2>
            <input
              ref={picker}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="flex items-center gap-4 rounded-lg border-[1.5px] border-dashed border-[#b9c0ca] p-[22px]">
              <FileText size={28} className="text-ink-2" />
              <div className="flex grow flex-col gap-0.5">
                <span className="text-base font-medium">{file ? file.name : 'Няма избран файл'}</span>
                <span className="text-xs text-ink-2">
                  {file ? `${(file.size / 1_000_000).toFixed(1)} MB` : 'Избери експорт от Shopify'}
                </span>
              </div>
              <Button type="button" onClick={() => picker.current?.click()}>
                {file ? 'Смени файла' : 'Избери файл'}
              </Button>
            </div>
            <span className="text-xs text-ink-2">Приема .xlsx и .csv. Най-добре пълен експорт от Shopify: Products → Export → All products.</span>
          </section>

          {analyze.isError && <div className="text-sm text-blocked-text">{(analyze.error as Error).message}</div>}
          <div className="flex justify-end gap-2.5">
            <Button size="lg" asChild>
              <Link to="/stores">Откажи</Link>
            </Button>
            <Button type="submit" variant="primary" size="lg" disabled={!file || analyze.isPending || (!existing && !form.name.trim())}>
              {analyze.isPending ? 'Анализирам…' : 'Анализирай магазина'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
