import * as React from 'react'
import { cn } from '@/lib/utils'
import { Label } from './label'
function Field({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="field" className={cn('flex min-w-0 flex-col gap-2', className)} {...props} />
  )
}
function FieldGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="field-group" className={cn('flex flex-col gap-5', className)} {...props} />
}
function FieldSet({ className, ...props }: React.ComponentProps<'fieldset'>) {
  return (
    <fieldset data-slot="field-set" className={cn('min-w-0 space-y-4', className)} {...props} />
  )
}
function FieldLegend({ className, ...props }: React.ComponentProps<'legend'>) {
  return <legend className={cn('mb-3 text-base font-semibold', className)} {...props} />
}
function FieldDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p className={cn('text-xs leading-relaxed text-muted-foreground', className)} {...props} />
}
function FieldError({ className, ...props }: React.ComponentProps<'p'>) {
  return <p role="alert" className={cn('text-sm text-destructive', className)} {...props} />
}
export {
  Field,
  FieldGroup,
  FieldSet,
  FieldLegend,
  FieldDescription,
  FieldError,
  Label as FieldLabel,
}
