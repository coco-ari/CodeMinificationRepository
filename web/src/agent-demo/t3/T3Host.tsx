import { useEffect, useState, type ComponentType } from 'react'
import {
  Button,
  Skeleton,
  installAutoOpsHost,
  type AutoOpsT3Bootstrap,
} from 'virtual:autoops-t3-host'

const bootstrapPath = '/api/agent-demo/t3/autoops/bootstrap'
let applicationPromise: Promise<ComponentType> | undefined

function loadApplication(bootstrap: AutoOpsT3Bootstrap): Promise<ComponentType> {
  installAutoOpsHost(bootstrap, window.location.origin)
  // StrictMode and retry share one router. Identity changes require a document
  // reload so singleton atoms and sockets cannot survive into another account.
  applicationPromise ??= createApplication(bootstrap).catch((error) => {
    applicationPromise = undefined
    throw error
  })
  return applicationPromise
}

async function createApplication(bootstrap: AutoOpsT3Bootstrap): Promise<ComponentType> {
  // The upstream stores initialize while these modules load. Authentication
  // and the storage namespace must exist first; no legacy transcript is fed in.
  const { AppRoot, getRouter, createHashHistory } = await import('virtual:autoops-t3-runtime')
  const history = createHashHistory()
  if (!window.location.hash && bootstrap.initialRoute) {
    history.replace(
      `/${encodeURIComponent(bootstrap.initialRoute.environmentId)}/${encodeURIComponent(bootstrap.initialRoute.threadId)}`,
    )
  }
  const router = getRouter(history)
  await router.load()
  return function AutoOpsT3Application() {
    return <AppRoot router={router} />
  }
}

export function T3Host({ onAuthRequired }: { onAuthRequired?: () => void }) {
  const [Application, setApplication] = useState<ComponentType | null>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    void (async () => {
      const response = await fetch(bootstrapPath, {
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (response.status === 401) {
        onAuthRequired?.()
        return
      }
      if (!response.ok) throw new Error('对话不可用')
      const bootstrap = (await response.json()) as AutoOpsT3Bootstrap
      if (controller.signal.aborted) return
      const Application = await loadApplication(bootstrap)
      if (!controller.signal.aborted) setApplication(() => Application)
    })().catch((error: unknown) => {
      if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
        console.error('AutoOps T3 initialization failed', error)
      if (!controller.signal.aborted) setError(true)
    })
    return () => controller.abort()
  }, [attempt, onAuthRequired])

  if (Application) return <Application />
  if (error)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-3" role="alert">
        <span>暂时无法加载对话</span>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          重试
        </Button>
      </div>
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6" aria-label="正在加载对话" aria-busy>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 max-w-xl" />
      <Skeleton className="mt-auto h-32" />
    </div>
  )
}
