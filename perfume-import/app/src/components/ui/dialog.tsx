import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactNode } from 'react'

// shadcn/ui dialog restyled: one shadow only, no animation on open (DESIGN.md anti-patterns).
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  footer: ReactNode
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/20" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border border-line bg-canvas p-6 shadow-[-8px_0_24px_rgba(26,29,33,0.06)]">
          <DialogPrimitive.Title className="m-0 text-lg font-semibold">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="m-0 text-sm leading-normal text-ink-3">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
          {children}
          <div className="flex justify-end gap-2">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
