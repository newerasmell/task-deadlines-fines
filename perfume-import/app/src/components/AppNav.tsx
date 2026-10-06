import { NavLink } from 'react-router'
import { cn } from '../lib/cn'

/** Top-level sections (Batches.dc.html / Stores.dc.html header). */
export function AppNav() {
  const link = ({ isActive }: { isActive: boolean }) =>
    cn('text-base no-underline', isActive ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink')
  return (
    <nav aria-label="Раздели" className="flex items-center gap-5">
      <NavLink to="/" end className={link}>
        Партиди
      </NavLink>
      <NavLink to="/audits" className={link}>
        Одит на каталог
      </NavLink>
      <NavLink to="/stores" className={link}>
        Магазини
      </NavLink>
    </nav>
  )
}
