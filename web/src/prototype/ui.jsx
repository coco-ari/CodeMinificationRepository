import { ArrowUpRight, Check, Circle, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function Picker({ value, onChange, options, label, className = '' }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function PageHeader({ title, children }) {
  return (
    <div className="proto-page-heading">
      <h1>{title}</h1>
      {children && <div className="proto-heading-actions">{children}</div>}
    </div>
  )
}

export function StateBadge({ children, tone = 'success' }) {
  return (
    <Badge variant="outline" className={`proto-status proto-status-${tone}`}>
      <Circle className="size-1.5 fill-current" />
      {children}
    </Badge>
  )
}

export function ArrowLink({ children, onClick }) {
  return (
    <Button
      variant="link"
      className="h-auto gap-1.5 p-0 text-xs text-muted-foreground hover:text-foreground"
      onClick={onClick}
    >
      {children}
      <ArrowUpRight className="size-3.5" />
    </Button>
  )
}

export async function copyText(value, label = '内容') {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`${label}已复制`)
  } catch {
    toast.error('复制失败，请选择内容后复制')
  }
}

export function CopyButton({ value, label = '复制提交号' }) {
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} onClick={() => copyText(value)}>
      <Copy className="size-3.5" />
    </Button>
  )
}

export function SmallEmpty({ title, description, children }) {
  return (
    <div className="py-12 text-center">
      <Check className="mx-auto mb-3 size-6 text-muted-foreground" />
      <h3 className="font-medium">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {children && <div className="mt-5">{children}</div>}
    </div>
  )
}
