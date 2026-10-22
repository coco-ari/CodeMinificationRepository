import React, { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { setNonce } from 'get-nonce'
import { Button } from 'virtual:autoops-t3-host'
import '~/index.css'
import { T3Host } from './t3/T3Host'
import { Login } from './t3/Login'

const nonce = document.querySelector('meta[name="csp-nonce"]')?.content
if (nonce && nonce !== '__CMR_STYLE_NONCE__') setNonce(nonce)

class DemoBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed)
      return (
        <main className="flex h-dvh flex-col items-center justify-center gap-4 px-6 text-sm">
          <h1>页面暂时无法显示</h1>
          <p>可以刷新重新连接，已经提交的任务仍在服务器上执行。</p>
          <Button onClick={() => location.reload()}>刷新页面</Button>
        </main>
      )
    return this.props.children
  }
}

function AgentWorkbench() {
  const [authRequired, setAuthRequired] = useState(false)
  const requireAuth = useCallback(() => setAuthRequired(true), [])
  const login = async (username, password) => {
    const response = await fetch('/api/agent-demo/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || '登录失败，请重试')
    window.location.reload()
  }
  return authRequired ? <Login login={login} /> : <T3Host onAuthRequired={requireAuth} />
}

createRoot(document.getElementById('root')).render(
  <DemoBoundary>
    <AgentWorkbench />
  </DemoBoundary>,
)
