import { Children, useId, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'

export function Choice({
  options,
  value,
  defaultValue,
  onValueChange,
  name,
  id,
  disabled,
  required,
  searchable = false,
  className,
  ...props
}) {
  const [local, setLocal] = useState(defaultValue ?? options[0]?.value ?? '')
  const [open, setOpen] = useState(false)
  const trigger = useRef(null)
  const listId = useId()
  const selected = String(value ?? local)
  const label = options.find((o) => String(o.value) === selected)?.label || '请选择'
  const change = (next) => {
    setLocal(next)
    onValueChange?.(next)
    trigger.current?.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const triggerProps = {
    id,
    disabled,
    ref: trigger,
    'aria-required': required || undefined,
    'data-required-choice': required ? selected || '' : undefined,
    ...props,
  }
  if (searchable)
    return (
      <>
        {name && <input type="hidden" name={name} value={selected} disabled={disabled} />}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              className={cn('h-9 w-full min-w-0 justify-between font-normal', className)}
              {...triggerProps}
            >
              <span className="truncate">{label}</span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-(--radix-popover-trigger-width) min-w-48 max-w-[calc(100vw-2rem)] p-0"
          >
            <Command>
              <CommandInput placeholder="搜索选项…" aria-label="搜索选项" />
              <CommandList id={listId}>
                <CommandEmpty>没有匹配的选项</CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <CommandItem
                      key={o.value}
                      value={`${o.label} ${o.value}`}
                      disabled={o.disabled}
                      onSelect={() => {
                        change(String(o.value))
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'size-4 shrink-0',
                          selected !== String(o.value) && 'opacity-0',
                        )}
                      />
                      <span className="break-words">{o.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </>
    )
  const empty = '__cmr_empty_choice__'
  return (
    <Select
      value={selected || empty}
      onValueChange={(v) => change(v === empty ? '' : v)}
      disabled={disabled}
    >
      {name && <input type="hidden" name={name} value={selected} disabled={disabled} />}
      <SelectTrigger className={className} {...triggerProps}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={String(o.value) || empty} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
export function Selection({ children, onChange, searchable, ...props }) {
  const options = Children.toArray(children)
    .filter(Boolean)
    .map((child) => ({
      value: String(child.props.value ?? ''),
      label: child.props.children,
      disabled: child.props.disabled,
    }))
  return (
    <Choice
      options={options}
      searchable={searchable ?? /服务器|部署位置/.test(props['aria-label'] || '')}
      {...props}
      onValueChange={(value) => onChange?.({ target: { value } })}
    />
  )
}
export function SelectionOption() {
  return null
}
