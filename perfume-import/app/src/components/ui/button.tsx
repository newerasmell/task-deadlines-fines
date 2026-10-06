import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../lib/cn'

// shadcn/ui button restyled with the DESIGN.md tokens: radius 6, no shadow, sentence case.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border text-sm no-underline transition-colors disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'border-transparent bg-accent font-medium text-white hover:bg-accent-hover hover:text-white disabled:bg-accent-disabled',
        secondary: 'border-line bg-canvas text-ink hover:bg-surface hover:text-ink disabled:text-muted',
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-surface hover:text-ink',
        chip: 'border-line bg-canvas text-ink hover:bg-surface hover:text-ink aria-pressed:border-ink aria-pressed:font-medium',
        dark: 'border-ink bg-ink font-medium text-white hover:text-white',
      },
      size: {
        sm: 'h-[30px] px-2.5',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-4 text-base',
        xl: 'h-11 px-[22px] text-base',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild, ...props }: Props) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
