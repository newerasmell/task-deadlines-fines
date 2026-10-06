import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import { ActorContext } from './actorContext'
import { api, AUTH_EVENT } from './api'

// Team login: nothing in the app is shown without a session. On an empty database the first person creates the
// admin account; after that an admin creates the others (Акаунт → Потребители).

export function ActorProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity })
  const refresh = useCallback(() => {
    client.clear() // another user must not see the previous one's cached data
    void me.refetch()
  }, [client, me])

  useEffect(() => {
    const onEnded = () => void me.refetch()
    window.addEventListener(AUTH_EVENT, onEnded)
    return () => window.removeEventListener(AUTH_EVENT, onEnded)
  }, [me])

  if (me.isPending) return <Loading what="входа" />
  if (me.isError) return <Failure error={me.error} retry={() => me.refetch()} />
  const user = me.data.user
  if (!user) return <Login setup={me.data.setup_needed} onDone={refresh} />

  const logout = () => void api.logout().finally(refresh)
  return (
    <ActorContext.Provider value={{ actor: user.name, user, ensure: () => Promise.resolve(user.name), logout }}>
      {children}
    </ActorContext.Provider>
  )
}

function Login({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (setup && password !== repeat) {
      setError('Паролите не съвпадат.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await (setup ? api.setup(name.trim(), password) : api.login(name.trim(), password))
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const input = 'h-9 rounded-md border border-line bg-canvas px-2.5 text-base text-ink'
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface p-4">
      <form onSubmit={submit} className="flex w-full max-w-[380px] flex-col gap-4 rounded-lg border border-line bg-canvas p-7">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[22px] font-semibold">{setup ? 'Първи администратор' : 'Вход'}</h1>
          <span className="text-sm leading-normal text-ink-2">
            {setup
              ? 'Още няма потребители. Създай своя акаунт; след това ти добавяш останалите от „Акаунт“.'
              : 'Perfume Import · въведи името и паролата си.'}
          </span>
        </div>
        <label className="flex flex-col gap-1.5 text-sm text-ink-2">
          Име
          <input autoFocus autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} className={input} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-ink-2">
          Парола{setup ? ' (поне 10 знака)' : ''}
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={input}
          />
        </label>
        {setup && (
          <label className="flex flex-col gap-1.5 text-sm text-ink-2">
            Повтори паролата
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={input} />
          </label>
        )}
        {error && <span className="text-sm text-blocked-text">{error}</span>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || !name.trim() || !password}>
          {setup ? 'Създай и влез' : 'Влез'}
        </Button>
      </form>
    </main>
  )
}
