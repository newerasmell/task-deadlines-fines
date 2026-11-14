import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type StoreRow } from '../lib/api'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

// The groups above the stores: a group without its structure (formulas for title and SKU, vocabulary, layout)
// learns it from its connected stores; „Нова група“ makes group 3 and on.
export function Groups({ stores }: { stores: StoreRow[] }) {
  const client = useQueryClient()
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups })
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const refresh = () => {
    for (const key of [['groups'], ['stores']]) void client.invalidateQueries({ queryKey: key })
  }
  const derive = async (key: string) => {
    setBusy(key)
    setError(null)
    try {
      const r = await api.deriveGroup(key)
      setNote(
        `Структурата е научена от ${r.stores.length === 1 ? '1 магазин' : `${r.stores.length} магазина`} (${r.products} продукта). Сега потвърди шаблоните на магазините.`,
      )
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const create = async () => {
    setError(null)
    try {
      const r = await api.createGroup(name)
      setNote(`${r.name} е създадена. Свържи магазините ѝ с „Добави магазин“ и избери нея.`)
      setNaming(false)
      setName('')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const pending = (groups.data ?? []).filter((g) => !g.ready)
  return (
    <div className="flex flex-col gap-2">
      {pending.map((g) => {
        const connected = stores.filter((s) => s.group === g.key && s.profile_id).length
        return (
          <div
            key={g.key}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-warning-tint px-4 py-2.5 text-sm"
          >
            <span className="grow">
              <b>{g.name}</b> още няма структура (формули за заглавие и SKU, речник, вид на снимката).{' '}
              {connected
                ? `Може да се научи от ${connected === 1 ? 'свързания магазин' : `${connected} свързани магазина`}.`
                : 'Свържи поне един магазин от нея, после я научи от него.'}
            </span>
            <Button variant="primary" disabled={!connected || busy === g.key} onClick={() => void derive(g.key)}>
              {busy === g.key ? 'Уча…' : 'Научи структурата'}
            </Button>
          </div>
        )
      })}
      <div className="flex items-center gap-3 text-sm">
        <Button size="sm" onClick={() => setNaming(true)}>
          Нова група
        </Button>
        {note && <span className="text-ok">{note}</span>}
        {error && <span className="text-blocked-text">{error}</span>}
      </div>
      {naming && (
        <Dialog
          open
          onOpenChange={(o) => !o && setNaming(false)}
          title="Нова група"
          description="Група е набор от магазини с еднакви правила (заглавие, SKU, метаполета). След като я създадеш, свържи магазините ѝ и научи структурата ѝ от тях."
          footer={
            <>
              <Button onClick={() => setNaming(false)}>Откажи</Button>
              <Button variant="primary" onClick={() => void create()}>
                Създай групата
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            Име
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Група 3"
              className="h-9 rounded-md border border-line bg-canvas px-2.5 text-sm font-normal"
            />
          </label>
        </Dialog>
      )}
    </div>
  )
}
