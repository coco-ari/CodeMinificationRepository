import { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Textarea } from '../../web/src/components/ui/textarea'
import {
  ClarificationDock,
  ComposerActions,
  QueueStrip,
  useComposerControls,
} from '../../web/src/agent-demo/conversation-controls'
import '../../web/src/index.css'
import '../../web/src/styles/solid-glass.css'
import '../../web/src/agent-demo/styles.css'

// Isolated component contract fixture; it does not pretend to execute an Agent.
const operations = []
const deferred = new Map()
let answerMode = 'fail'
function ControlsHarness() {
  const [text, setText] = useState('测试消息')
  const [settings, setSettings] = useState({
    userId: 'controls-a',
    running: true,
    sending: false,
    stopping: false,
    connected: true,
    canSteer: true,
    hasAttachments: false,
  })
  const [items, setItems] = useState([
    { id: 'q1', text: '第一条排队消息', attachments: [{ name: '说明.txt' }] },
  ])
  const [paused, setPaused] = useState(false)
  const [question, setQuestion] = useState({
    id: 'question-a',
    status: 'pending',
    prompt: '选择环境',
    options: ['测试环境', '生产环境'],
  })
  const canSend =
    Boolean(text || settings.hasAttachments) &&
    settings.connected &&
    !settings.sending &&
    !settings.stopping
  const onSend = (delivery) => operations.push({ kind: 'send', delivery, text })
  const controls = useComposerControls({ ...settings, canSend, onSend })
  useLayoutEffect(() => {
    window.controlsHarness = {
      settings: (patch) => setSettings((old) => ({ ...old, ...patch })),
      text: setText,
      behavior: controls.setBehavior,
      operations: () => operations,
      clear: () => {
        operations.length = 0
      },
      question: setQuestion,
      items: setItems,
      answerMode: (value) => {
        answerMode = value
      },
      resolve: (id) => deferred.get(id)?.({ ok: true }),
    }
  })
  return (
    <main style={{ maxWidth: 720, margin: '16px auto', padding: 12 }}>
      <Textarea
        aria-label="测试输入问题"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={controls.onKeyDown}
        onCompositionStart={controls.onCompositionStart}
        onCompositionEnd={controls.onCompositionEnd}
      />
      <ComposerActions
        {...settings}
        {...controls}
        hasContent={Boolean(text || settings.hasAttachments)}
        canSend={canSend}
        onSend={onSend}
        onStop={() => operations.push({ kind: 'stop' })}
      />
      <QueueStrip
        items={items}
        paused={paused}
        running={settings.running}
        connected={settings.connected}
        onPause={() => {
          operations.push({ kind: 'pause' })
          setPaused(true)
        }}
        onResume={() => {
          operations.push({ kind: 'resume' })
          setPaused(false)
        }}
        onEdit={(item) => operations.push({ kind: 'edit', id: item.id })}
        onRemove={(item) => operations.push({ kind: 'remove', id: item.id })}
        onMove={(id, direction) => operations.push({ kind: 'move', id, direction })}
        onSend={(item) => operations.push({ kind: 'send-queue', id: item.id })}
      />
      <ClarificationDock
        userId={settings.userId}
        conversationId="conversation-a"
        question={question}
        onAnswer={async (answer, target) => {
          operations.push({ kind: 'answer', id: target.id, answer })
          if (answerMode === 'fail') throw new Error('测试服务器拒绝，请重试')
          if (answerMode === 'unconfirmed') return false
          if (answerMode === 'pending')
            return new Promise((resolve) => deferred.set(target.id, resolve))
          return { ok: true }
        }}
      />
    </main>
  )
}
createRoot(document.getElementById('root')).render(<ControlsHarness />)
