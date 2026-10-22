import React from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import '@/styles/solid-glass.css'
import './v2/v2.css'
import PrototypeApp from './v2/App'
import { WorkbenchProvider as PrototypeProvider } from './v2/store'
import { Button } from '@/components/ui/button'

class PrototypeBoundary extends React.Component {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (this.state.failed) {
      return (
        <main className="mx-auto max-w-lg space-y-4 p-10">
          <h1 className="text-xl font-semibold">原型页面暂时无法显示</h1>
          <p className="text-sm text-muted-foreground">
            可以先刷新重试；若浏览器保存的示例数据有误，可重置为初始状态。
          </p>
          <div className="flex gap-3">
            <Button onClick={() => location.reload()}>刷新页面</Button>
            <Button
              variant="outline"
              onClick={() => {
                localStorage.removeItem('autoops:interactive-prototype:v2')
                location.hash = '/overview'
                location.reload()
              }}
            >
              重置示例
            </Button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <PrototypeBoundary>
    <PrototypeProvider>
      <PrototypeApp />
    </PrototypeProvider>
  </PrototypeBoundary>,
)
