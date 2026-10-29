import { GitBranchIcon, GitCommitHorizontalIcon, TagIcon } from 'lucide-react'
import type { DeploymentRelease } from '../deployments'
import { normalizeDirectory } from './deploymentPresentation'

export function DeploymentReleaseIdentity({
  release,
  limit = 3,
}: {
  release: DeploymentRelease
  limit?: number
}) {
  const repositories = release.sourceIdentity?.repositories ?? []
  const selections = release.sourceSelection?.sources ?? []
  return (
    <div className="min-w-0 space-y-1">
      {repositories.length ? (
        repositories.slice(0, limit).map((repository) => {
          const configured = selections.find(
            (entry) => normalizeDirectory(entry.mountPath) === normalizeDirectory(repository.path),
          )
          const selection =
            release.sourceRefs?.find(
              (entry) =>
                entry.sourceId === configured?.sourceId && entry.commit === repository.commit,
            ) ?? configured
          return (
            <div
              key={repository.path}
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
            >
              {repositories.length > 1 ? (
                <span className="truncate text-muted-foreground" title={repository.path}>
                  {repository.path || '仓库根目录'}
                </span>
              ) : null}
              {selection?.refKind === 'branch' || selection?.refKind === 'tag' ? (
                <span
                  className="inline-flex min-w-0 max-w-full items-center gap-1"
                  title={selection.ref}
                >
                  {selection.refKind === 'branch' ? (
                    <GitBranchIcon
                      className="size-3 shrink-0 text-muted-foreground"
                      aria-label="分支"
                    />
                  ) : (
                    <TagIcon className="size-3 shrink-0 text-muted-foreground" aria-label="标签" />
                  )}
                  <span className="truncate">{selection.ref}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {selection?.refKind === 'commit' ? '完整提交' : '来源引用未记录'}
                </span>
              )}
              <span
                className="inline-flex min-w-0 items-center gap-1"
                title={`Commit ${repository.commit}`}
              >
                <GitCommitHorizontalIcon
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label="Commit"
                />
                <code className="truncate">{repository.commit.slice(0, 12)}</code>
              </span>
            </div>
          )
        })
      ) : (
        <span className="break-all font-mono text-xs" title={release.revision ?? release.id}>
          {release.revision?.slice(0, 12) ?? release.id.slice(0, 8)}
        </span>
      )}
      {repositories.length > limit ? (
        <span className="text-xs text-muted-foreground">
          另 {repositories.length - limit} 个仓库，见来源详情
        </span>
      ) : null}
    </div>
  )
}
