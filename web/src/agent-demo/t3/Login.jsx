import { useState } from 'react'
import { ArrowRight, CircleAlert, LoaderCircle } from 'lucide-react'
import { Button, Input, Label } from 'virtual:autoops-t3-host'

export function Login({ login, error: initialError }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <main className="flex h-dvh items-center justify-center overflow-y-auto bg-background px-6 py-8 text-foreground">
      <section aria-labelledby="login-title" className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span
            className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            A
          </span>
          <span>AutoOps</span>
        </div>
        <h1 id="login-title" className="text-xl font-semibold tracking-tight">
          登录工作台
        </h1>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            try {
              await login(username, password)
            } catch (failure) {
              setError(failure.message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="workbench-demo-username">账号</Label>
            <Input
              id="workbench-demo-username"
              aria-label="用户名"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="workbench-demo-password">密码</Label>
            <Input
              id="workbench-demo-password"
              aria-label="密码"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          {(error || initialError) && (
            <div
              className="flex items-start gap-2 text-sm text-destructive-foreground"
              role="alert"
            >
              <CircleAlert size={15} />
              {error || initialError}
            </div>
          )}
          <Button disabled={busy || !username.trim() || !password} type="submit" className="w-full">
            {busy ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
            {busy ? '正在登录…' : '登录'}
          </Button>
        </form>
        <div className="flex flex-col gap-1 border-t border-border pt-4 text-xs text-muted-foreground">
          <span>测试账号：admin / lin / chen</span>
          <span>演示口令：Demo123!</span>
        </div>
      </section>
    </main>
  )
}
