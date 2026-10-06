import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button } from '../components/ui/button'
import { Dialog } from '../components/ui/dialog'
import { ActorContext } from './actorContext'
import { getActor, setActor } from './api'

// Every decision is recorded with who made it (SPEC §3 decided_by). Until the team login is connected the name
// is asked once and kept in this browser.

export function ActorProvider({ children }: { children: ReactNode }) {
  const [actor, setActorState] = useState(getActor())
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const pending = useRef<((name: string | null) => void) | null>(null)

  const ask = useCallback(() => {
    setDraft(getActor())
    setOpen(true)
    return new Promise<string | null>((resolve) => {
      pending.current = resolve
    })
  }, [])

  const ensure = useCallback(() => (actor ? Promise.resolve(actor) : ask()), [actor, ask])

  const finish = (name: string | null) => {
    if (name) {
      setActor(name)
      setActorState(name)
    }
    setOpen(false)
    pending.current?.(name)
    pending.current = null
  }

  return (
    <ActorContext.Provider value={{ actor, ensure, change: () => void ask() }}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(o) => !o && finish(null)}
        title="Кой преглежда?"
        description="Името се записва към всяко решение. Пита се веднъж на този браузър."
        footer={
          <>
            <Button onClick={() => finish(null)}>Откажи</Button>
            <Button variant="primary" disabled={!draft.trim()} onClick={() => finish(draft.trim())}>
              Запази името
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) finish(draft.trim())
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm text-ink-2">
            Име
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-9 rounded-md border border-line px-2.5 text-base text-ink"
            />
          </label>
        </form>
      </Dialog>
    </ActorContext.Provider>
  )
}
