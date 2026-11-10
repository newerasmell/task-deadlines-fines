import { NavLink } from 'react-router'
import { useActor } from '../lib/actorContext'
import { cn } from '../lib/cn'

/** Top-level sections: the products of every store, a new product, the stores. */
export function AppNav() {
  const { user } = useActor()
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('text-base no-underline', isActive ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink')
  return (
    <nav aria-label="Раздели" className="flex items-center gap-5">
      <NavLink to="/" end className={link}>
        Продукти
      </NavLink>
      <NavLink to="/new" className={link}>
        Нов продукт
      </NavLink>
      <NavLink to="/stores" className={link}>
        Магазини
      </NavLink>
      <NavLink to="/account" className={link} title="Парола, потребители, изход">
        {user.name}
      </NavLink>
    </nav>
  )
}
