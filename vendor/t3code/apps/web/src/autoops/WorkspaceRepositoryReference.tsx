import { useEffect, useRef, useState } from 'react'
import { RefreshCwIcon } from 'lucide-react'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Spinner } from '~/components/ui/spinner'
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from '~/components/ui/autocomplete'
import { checkProjectRepository } from './projectRepositories'
import type { WorkspaceRepositoryUsageInput } from './workspaceAuthoring'

type References = Awaited<ReturnType<typeof checkProjectRepository>>
type ReadState =
  | { status: 'loading' }
  | { status: 'ready'; value: References }
  | { status: 'error'; message: string }

/** 只查询当前仓库的引用候选，选择或手填只改变工作区表单草稿。 */
export function WorkspaceRepositoryReference({
  projectId,
  repositoryId,
  refKind,
  value,
  disabled,
  onChange,
}: {
  projectId: string
  repositoryId: string
  refKind: WorkspaceRepositoryUsageInput['refKind']
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [state, setState] = useState<ReadState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const container = useRef<HTMLDivElement>(null)
  const lookup = !!repositoryId && refKind !== 'commit'
  useEffect(() => {
    if (!lookup) return
    const abort = new AbortController()
    setState({ status: 'loading' })
    void checkProjectRepository(projectId, repositoryId, abort.signal)
      .then((result) => {
        if (!abort.signal.aborted) setState({ status: 'ready', value: result })
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted)
          setState({
            status: 'error',
            message: cause instanceof Error ? cause.message : '仓库引用读取失败。',
          })
      })
    return () => abort.abort()
  }, [projectId, repositoryId, lookup, attempt])

  if (refKind === 'commit')
    return (
      <div className="min-w-0 space-y-1.5">
        <Label>提交 SHA</Label>
        <Input
          aria-label="提交 SHA"
          value={value}
          disabled={disabled}
          placeholder="填写完整提交 SHA"
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    )
  const label = refKind === 'tag' ? '标签' : '分支'
  const refs = state.status === 'ready' ? state.value : null
  const items = (refKind === 'tag' ? refs?.tags : refs?.branches)?.map((item) => item.name) ?? []
  const pending = lookup && state.status === 'loading'
  return (
    <div ref={container} className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-2">
        <Label>{refKind === 'default' ? '远端默认分支' : label}</Label>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="ml-auto"
          aria-label={state.status === 'error' ? '重试读取仓库引用' : '刷新仓库引用'}
          disabled={disabled || !repositoryId || pending}
          onClick={() => setAttempt((current) => current + 1)}
        >
          {pending ? <Spinner size="sm" /> : <RefreshCwIcon />}
        </Button>
      </div>
      {refKind === 'default' ? (
        <p className="text-sm text-muted-foreground" role="status">
          {!repositoryId
            ? '选择项目仓库后读取默认分支。'
            : pending
              ? '正在读取远端默认分支…'
              : refs?.defaultRef
                ? refs.defaultRef
                : state.status === 'error'
                  ? '默认分支暂时无法查询。'
                  : '仓库未返回默认分支。'}
        </p>
      ) : (
        <Autocomplete
          key={refKind}
          items={items}
          value={value}
          onValueChange={onChange}
          disabled={disabled || !repositoryId}
          limit={100}
        >
          <AutocompleteInput
            aria-label={label}
            showTrigger
            placeholder={`搜索、选择或填写${label}`}
          />
          <AutocompletePopup container={container}>
            <AutocompleteEmpty>
              {pending
                ? `正在读取${label}…`
                : state.status === 'error'
                  ? '暂时无法查询，可以重试或手动填写。'
                  : items.length === 0
                    ? `仓库没有返回${label}，可手动填写。`
                    : '没有匹配项，可保留手动输入。'}
            </AutocompleteEmpty>
            <AutocompleteList>
              {(name: string) => (
                <AutocompleteItem key={name} value={name}>
                  <span className="min-w-0 truncate" title={name}>
                    {name}
                  </span>
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
      )}
      {lookup && state.status === 'error' ? (
        <Alert variant="error" role="alert">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
      {refs?.truncated ? (
        <p className="text-xs text-muted-foreground">
          远端仅返回部分引用，未列出的名称可手动填写。
        </p>
      ) : items.length > 100 && refKind !== 'default' ? (
        <p className="text-xs text-muted-foreground">候选较多，请输入名称搜索。</p>
      ) : null}
    </div>
  )
}
