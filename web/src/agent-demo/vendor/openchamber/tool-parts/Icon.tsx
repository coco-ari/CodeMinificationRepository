// Icon adapter for copied OpenChamber JSON views; no behavior changes.
import { ChevronRight } from 'lucide-react'
export function Icon({ name: _name, ...props }: { name: string; className?: string }) {
  return <ChevronRight {...props} />
}
