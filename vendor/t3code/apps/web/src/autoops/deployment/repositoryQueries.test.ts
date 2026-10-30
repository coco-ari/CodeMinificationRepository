import { expect, it, vi } from 'vite-plus/test'
import { createDeploymentRepositoryQueries } from './repositoryQueries'
import { DeploymentRequestError } from '../deployments'

const api = vi.hoisted(() => ({ refs: vi.fn(), history: vi.fn() }))
vi.mock(import('../deployments'), async original => ({
  ...await original(),
  loadDeploymentRepositoryRefs: api.refs,
  loadDeploymentRepositoryHistory: api.history,
}))
const reference = { refKind: 'branch' as const, ref: 'main' }
function setup() {
  vi.resetAllMocks()
  api.refs.mockResolvedValue({ sourceId: 'repo', defaultRef: 'main', branches: [], tags: [], truncated: false })
  api.history.mockImplementation(async (_p, source, ref) => ({ sourceId: source, ...ref, commits: [] }))
  return createDeploymentRepositoryQueries('project')
}

it('同引用共享进行中的查询，不同仓库及引用分别读取', async () => {
  const queries = setup()
  let resolve!: (value: object) => void
  api.history.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const first = queries.history('repo', reference)
  const second = queries.history('repo', reference)
  expect(api.history).toHaveBeenCalledTimes(1)
  resolve({ commits: [] })
  expect(await first).toEqual(await second)
  await queries.history('other', reference)
  await queries.history('repo', { ...reference, ref: 'feature' })
  await queries.history('repo', { refKind: 'tag', ref: 'main' })
  expect(api.history).toHaveBeenCalledTimes(4)
  queries.dispose()
})

it('提交与分支分别保鲜，手动刷新绕过成功缓存', async () => {
  const queries = setup()
  using clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  await queries.refs('repo')
  await queries.history('repo', reference)
  clock.mockReturnValue(60_999)
  await queries.history('repo', reference)
  expect(api.history).toHaveBeenCalledTimes(1)
  clock.mockReturnValue(61_000)
  await queries.history('repo', reference)
  await queries.refs('repo')
  expect(api.history).toHaveBeenCalledTimes(2)
  expect(api.refs).toHaveBeenCalledTimes(1)
  await queries.history('repo', reference, true)
  expect(api.history).toHaveBeenCalledTimes(3)
  clock.mockReturnValue(301_000)
  await queries.refs('repo')
  expect(api.refs).toHaveBeenCalledTimes(2)
  queries.dispose()
})

it('关闭范围后取消旧请求，即使实现忽略取消也拒绝迟到结果', async () => {
  const queries = setup()
  let resolve!: (value: object) => void
  api.history.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const work = queries.history('repo', reference)
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  const signal = api.history.mock.calls[0]![3] as AbortSignal
  queries.dispose()
  expect(signal.aborted).toBe(true)
  resolve({ commits: [] })
  await rejected
  const next = createDeploymentRepositoryQueries('other-project')
  await next.history('repo', reference)
  expect(api.history).toHaveBeenLastCalledWith('other-project', 'repo', reference, expect.any(AbortSignal))
  next.dispose()
})

it('权限拒绝清除整个范围，失败结果不缓存', async () => {
  const queries = setup()
  await queries.refs('repo')
  api.history.mockRejectedValueOnce(new DeploymentRequestError('权限已撤回', false, 403))
  await expect(queries.history('repo', reference)).rejects.toMatchObject({ status: 403 })
  await queries.refs('repo')
  await queries.history('repo', reference)
  expect(api.refs).toHaveBeenCalledTimes(2)
  expect(api.history).toHaveBeenCalledTimes(2)
  queries.dispose()
})
