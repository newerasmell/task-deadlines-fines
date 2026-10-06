import { createContext, useContext } from 'react'

type Ctx = { actor: string; ensure: () => Promise<string | null>; change: () => void }
export const ActorContext = createContext<Ctx | null>(null)

export function useActor(): Ctx {
  const ctx = useContext(ActorContext)
  if (!ctx) throw new Error('useActor outside ActorProvider')
  return ctx
}
