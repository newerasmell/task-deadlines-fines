import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { AppNav } from '../components/AppNav'
import { Failure, Loading } from '../components/States'
import { Button } from '../components/ui/button'
import { useActor } from '../lib/actorContext'
import { api, type User } from '../lib/api'

// Account: own password and logout; for admins the team's users (create, reset password, admin, disable).

const input = 'h-9 min-w-0 rounded-md border border-line bg-canvas px-2.5 text-sm text-ink'

export function AccountScreen() {
  const { user, logout } = useActor()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line px-7">
        <AppNav />
        <div className="grow" />
        <Button onClick={logout}>Изход</Button>
      </header>
      <main className="flex max-w-[1000px] flex-col gap-8 p-7">
        <section className="flex flex-col gap-3">
          <h1 className="m-0 text-[22px] font-semibold">{user.name}</h1>
          <span className="text-sm text-ink-2">{user.is_admin ? 'Администратор' : 'Потребител'}</span>
          <OwnPassword />
        </section>
        {user.is_admin && <Users me={user} />}
      </main>
    </div>
  )
}

function OwnPassword() {
  const { logout } = useActor()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const change = useMutation({ mutationFn: () => api.changePassword(current, next), onSuccess: () => logout() })
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        change.mutate()
      }}
    >
      <h2 className="m-0 text-base font-semibold">Смени паролата</h2>
      <div className="flex flex-wrap gap-2">
        <input type="password" placeholder="Сегашна парола" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        <input type="password" placeholder="Нова (поне 10 знака)" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
        <Button type="submit" disabled={!current || next.length < 10 || change.isPending}>
          Смени и влез отново
        </Button>
      </div>
      {change.isError && <span className="text-sm text-blocked-text">{(change.error as Error).message}</span>}
    </form>
  )
}

function Users({ me }: { me: User }) {
  const client = useQueryClient()
  const users = useQuery({ queryKey: ['users'], queryFn: api.users })
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [admin, setAdmin] = useState(false)
  const refresh = () => client.invalidateQueries({ queryKey: ['users'] })
  const create = useMutation({
    mutationFn: () => api.createUser(name.trim(), password, admin),
    onSuccess: () => {
      setName('')
      setPassword('')
      setAdmin(false)
      void refresh()
    },
  })
  const update = useMutation({
    mutationFn: (a: { id: number; change: Parameters<typeof api.updateUser>[1] }) => api.updateUser(a.id, a.change),
    onSuccess: () => void refresh(),
  })

  const add = (e: FormEvent) => {
    e.preventDefault()
    create.mutate()
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-base font-semibold">Потребители</h2>
      <form onSubmit={add} className="flex flex-wrap items-center gap-2">
        <input placeholder="Име" value={name} onChange={(e) => setName(e.target.value)} className={input} />
        <input type="password" placeholder="Парола (поне 10 знака)" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
          администратор
        </label>
        <Button type="submit" variant="primary" disabled={!name.trim() || password.length < 10 || create.isPending}>
          Добави
        </Button>
      </form>
      <span className="text-xs leading-normal text-ink-2">
        Кажи паролата на човека лично; той може да я смени от „Акаунт“. Администраторите въвеждат ключовете за
        Shopify и управляват потребителите.
      </span>
      {create.isError && <span className="text-sm text-blocked-text">{(create.error as Error).message}</span>}
      {update.isError && <span className="text-sm text-blocked-text">{(update.error as Error).message}</span>}
      {users.isPending ? (
        <Loading what="потребителите" />
      ) : users.isError ? (
        <Failure error={users.error} retry={() => users.refetch()} />
      ) : (
        <div className="flex flex-col rounded-lg border border-line" role="table" aria-label="Потребители">
          {users.data.map((u) => (
            <UserRow key={u.id} u={u} self={u.id === me.id} busy={update.isPending} onChange={(change) => update.mutate({ id: u.id, change })} />
          ))}
        </div>
      )}
    </section>
  )
}

function UserRow({
  u,
  self,
  busy,
  onChange,
}: {
  u: User
  self: boolean
  busy: boolean
  onChange: (change: { password?: string; is_admin?: boolean; disabled?: boolean }) => void
}) {
  const [reset, setReset] = useState('')
  return (
    <div role="row" className="flex flex-wrap items-center gap-3 border-b border-line-2 px-4 py-2.5 text-sm last:border-b-0">
      <span role="cell" className={u.disabled ? 'min-w-[140px] text-ink-2 line-through' : 'min-w-[140px] font-medium'}>
        {u.name}
      </span>
      <span role="cell" className="min-w-[110px] text-ink-2">
        {u.is_admin ? 'администратор' : 'потребител'}
        {u.disabled ? ' · спрян' : ''}
      </span>
      <div className="grow" />
      {!self && (
        <>
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              onChange({ password: reset })
              setReset('')
            }}
          >
            <input type="password" placeholder="Нова парола" autoComplete="new-password" value={reset} onChange={(e) => setReset(e.target.value)} className={`${input} w-[150px]`} />
            <Button type="submit" size="sm" disabled={reset.length < 10 || busy}>
              Смени
            </Button>
          </form>
          <Button size="sm" disabled={busy} onClick={() => onChange({ is_admin: !u.is_admin })}>
            {u.is_admin ? 'Махни админ' : 'Направи админ'}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => onChange({ disabled: !u.disabled })}>
            {u.disabled ? 'Пусни' : 'Спри'}
          </Button>
        </>
      )}
    </div>
  )
}
