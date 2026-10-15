import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldSet, FieldLegend, FieldDescription } from '@/components/ui/field'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'

export function Advanced({ title, children }) {
  const [open, setOpen] = useState('')
  return (
    <Accordion
      type="single"
      collapsible
      value={open}
      onValueChange={setOpen}
      className="rounded-md border px-3"
    >
      <AccordionItem value="advanced">
        <AccordionTrigger>{title}</AccordionTrigger>
        <AccordionContent forceMount data-slot="advanced-content" className={open ? '' : 'hidden'}>
          {children}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
export function MappingRows({ name, title, columns, initial, emptyRow, hint }) {
  const [rows, setRows] = useState(() => initial.map((value, i) => ({ key: String(i), value })))
  const signal = (event) => event.currentTarget.dispatchEvent(new Event('input', { bubbles: true }))
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      {rows.map((row, index) => (
        <div className="flex items-end gap-2 rounded-md border bg-muted/20 p-3" key={row.key}>
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-3">
            {columns.map((col) => (
              <div key={col.key} className="min-w-0 space-y-1.5">
                <Label className="text-xs" htmlFor={`${name}-${row.key}-${col.key}`}>
                  {col.label}
                </Label>
                <Input
                  id={`${name}-${row.key}-${col.key}`}
                  aria-label={`${title} ${index + 1} ${col.label}`}
                  type={col.type || 'text'}
                  min={col.min}
                  max={col.max}
                  required
                  value={row.value[col.key]}
                  onChange={(e) =>
                    setRows((all) =>
                      all.map((r) =>
                        r.key === row.key
                          ? { ...r, value: { ...r.value, [col.key]: e.target.value } }
                          : r,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`删除${title} ${index + 1}`}
            onClick={(e) => {
              signal(e)
              setRows((all) => all.filter((r) => r.key !== row.key))
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <input name={name} type="hidden" value={JSON.stringify(rows.map((r) => r.value))} />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={(e) => {
          signal(e)
          setRows((all) => [...all, { key: crypto.randomUUID(), value: { ...emptyRow } }])
        }}
      >
        <Plus />
        添加{title}
      </Button>
      <FieldDescription>{hint}</FieldDescription>
    </FieldSet>
  )
}
