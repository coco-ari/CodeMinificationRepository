import React from 'react'
import { setNonce } from 'get-nonce'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

// Radix 的滚动锁通过受信任的随机 nonce 注入样式，脚本策略继续仅允许同源。
const nonce = document.querySelector('meta[name="csp-nonce"]')?.content
if (nonce && nonce !== '__CMR_STYLE_NONCE__') setNonce(nonce)

class ErrorBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <main className="mx-auto max-w-lg p-10">
        <h1 className="text-xl font-semibold">页面加载异常</h1>
        <p className="my-4 text-muted-foreground">请刷新页面重试，已保存的项目配置不受影响。</p>
        <button className="underline" onClick={() => location.reload()}>
          刷新页面
        </button>
      </main>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
