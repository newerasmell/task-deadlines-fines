import type { ReactNode } from 'react'
import { Button } from './ui/button'

export function Loading({ what }: { what: string }) {
  return <div className="p-7 text-sm text-ink-2">Зареждам {what}…</div>
}

export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="flex flex-col items-start gap-3 p-7 text-sm">
      <span className="text-blocked-text">{message}</span>
      {retry && <Button onClick={retry}>Опитай отново</Button>}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-7 text-sm text-ink-2">{children}</div>
}
