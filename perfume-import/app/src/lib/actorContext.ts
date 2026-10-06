import { createContext, useContext } from 'react'
import type { User } from './api'

// The logged-in user: every decision is recorded with their name (SPEC §3 decided_by).
type Ctx = { actor: string; user: User; ensure: () => Promise<string | null>; logout: () => void }
export const ActorContext = createContext<Ctx | null>(null)

export function useActor(): Ctx {
  const ctx = useContext(ActorContext)
  if (!ctx) throw new Error('useActor outside ActorProvider')
  return ctx
}
