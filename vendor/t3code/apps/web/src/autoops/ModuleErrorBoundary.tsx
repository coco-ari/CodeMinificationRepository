import { createContext, useContext, type ReactNode } from 'react'
import { CatchBoundary, type ErrorComponentProps } from '@tanstack/react-router'
import { RefreshCwIcon } from 'lucide-react'
import { WorkspacePageHeader } from '~/components/WorkspacePageHeader'
import { Button } from '~/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '~/components/ui/empty'
import { ModuleSidebar, ModuleSidebarEmpty } from './ModuleWorkspace'

const ModuleName = createContext('当前模块')

function ModuleFailure({ reset }: ErrorComponentProps) {
  const label = useContext(ModuleName)
  return (
    <main
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      aria-label={label}
      data-module-error=""
    >
      <ModuleSidebar label={label}>
        <ModuleSidebarEmpty>当前内容暂时无法显示，可重试或切换其他模块。</ModuleSidebarEmpty>
      </ModuleSidebar>
      <WorkspacePageHeader>
        <h1 className="truncate text-sm font-medium">{label}</h1>
      </WorkspacePageHeader>
      <Empty size="compact" role="alert">
        <EmptyHeader>
          <EmptyTitle>{label}暂时无法显示</EmptyTitle>
          <EmptyDescription>
            可重试当前内容，或使用顶部导航继续操作其他模块。已提交的后台任务仍按原流程执行。
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" onClick={reset}>
          <RefreshCwIcon />
          重试当前模块
        </Button>
      </Empty>
    </main>
  )
}

/** 复用路由库的错误边界；只重试内容，不重建公共壳、不重发业务动作。 */
export function ModuleErrorBoundary({
  children,
  resetKey,
  label,
}: {
  children: ReactNode
  resetKey: string
  label: string
}) {
  return (
    <ModuleName value={label}>
      <CatchBoundary getResetKey={() => resetKey} errorComponent={ModuleFailure}>
        {children}
      </CatchBoundary>
    </ModuleName>
  )
}
