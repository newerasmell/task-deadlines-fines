import type { Status } from './api'

export const TINT: Record<Status, string> = {
  ok: 'bg-ok-tint',
  suggested: 'bg-suggested-tint',
  fixed: 'bg-fixed-tint',
  warning: 'bg-warning-tint',
  blocked: 'bg-blocked-tint',
}

/** DESIGN.md: a status cell is a 10% tint plus a 3 px bar in the full colour; ok cells stay plain. */
export const BAR: Record<Status, string> = {
  ok: '',
  suggested: 'shadow-[inset_3px_0_0_var(--color-suggested)]',
  fixed: 'shadow-[inset_3px_0_0_var(--color-fixed)]',
  warning: 'shadow-[inset_3px_0_0_var(--color-warning)]',
  blocked: 'shadow-[inset_3px_0_0_var(--color-blocked)]',
}

export const TAG_TEXT: Record<Status, string> = {
  ok: 'text-ok',
  suggested: 'text-suggested-text',
  fixed: 'text-fixed-text',
  warning: 'text-warning-text',
  blocked: 'text-blocked-text',
}
