import { LRUCache } from '~/lib/lruCache'
import {
  loadDeploymentRepositoryRefs,
  loadDeploymentRepositoryHistory,
  isDeploymentAccessError,
  type DeploymentRepositoryRefs,
  type DeploymentRepositoryHistory,
} from '../deployments'

type Result<T> = { data: T; updatedAt: number }
type Entry = Result<DeploymentRepositoryRefs | DeploymentRepositoryHistory>

/** 由部署页面持有；服务共享只读 Git 查询，离开授权范围后释放全部结果和请求。 */
export function createDeploymentRepositoryQueries(projectId: string) {
  const cache = new LRUCache<Entry>(100, 4 * 1024 * 1024)
  const pending = new Map<string, Promise<Entry>>()
  let controller = new AbortController()
  const clear = () => {
    controller.abort()
    controller = new AbortController()
    pending.clear()
    cache.clear()
  }
  async function read<T extends Entry['data']>(
    key: string,
    maxAge: number,
    force: boolean,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<Result<T>> {
    const running = pending.get(key)
    if (running) return running as Promise<Result<T>>
    const previous = cache.get(key)
    if (!force && previous && Date.now() - previous.updatedAt < maxAge)
      return previous as Result<T>
    const signal = controller.signal
    const work = load(signal)
      .then((data) => {
        signal.throwIfAborted()
        const result = { data, updatedAt: Date.now() }
        cache.set(key, result, JSON.stringify(data).length * 2)
        return result
      })
      .catch((cause: unknown) => {
        if (!signal.aborted && isDeploymentAccessError(cause)) clear()
        throw cause
      })
      .finally(() => {
        if (pending.get(key) === work) pending.delete(key)
      })
    pending.set(key, work)
    return work
  }
  return {
    refs: (sourceId: string, force = false) =>
      read(JSON.stringify(['refs', sourceId]), 300_000, force, (signal) =>
        loadDeploymentRepositoryRefs(projectId, sourceId, signal),
      ),
    history: (
      sourceId: string,
      reference: { refKind: 'default' | 'branch' | 'tag' | 'commit'; ref: string },
      force = false,
    ) =>
      read(
        JSON.stringify(['history', sourceId, reference.refKind, reference.ref]),
        60_000,
        force,
        (signal) => loadDeploymentRepositoryHistory(projectId, sourceId, reference, signal),
      ),
    clear,
    dispose() {
      clear()
    },
  }
}

export type DeploymentRepositoryQueries = ReturnType<typeof createDeploymentRepositoryQueries>
