import type { Status } from '../lib/api'
import { cn } from '../lib/cn'

const COLOR: Record<Status, string> = {
  ok: 'bg-ok',
  suggested: 'bg-suggested',
  fixed: 'bg-fixed',
  warning: 'bg-warning',
  blocked: 'bg-blocked',
}

/** The 8 px square used in lists and filter chips (mockups). */
export function StatusMark({ status, className }: { status: Status; className?: string }) {
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-[2px]', COLOR[status], className)} />
}
