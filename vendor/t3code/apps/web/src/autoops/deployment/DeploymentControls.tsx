import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '~/components/ui/select'

export function DeploymentEmpty({ title, description }: { title: string; description: string }) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = '请选择',
}: {
  label: string
  value: string
  options: Array<{ id: string; name: string }>
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select
      value={value}
      disabled={disabled || !options.length}
      onValueChange={(next) => {
        if (typeof next === 'string') onChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <span className="min-w-0 flex-1 truncate">
          <SelectValue>{options.find((entry) => entry.id === value)?.name ?? placeholder}</SelectValue>
        </span>
      </SelectTrigger>
      <SelectPopup>
        {options.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            {entry.name}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  )
}
