import { useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '../../web/src/components/ui/tooltip'
import { Chat } from '../../web/src/agent-demo/Chat'
import { useDemo } from '../../web/src/agent-demo/use-demo'
import '../../web/src/index.css'
import '../../web/src/styles/solid-glass.css'
import '../../web/src/agent-demo/styles.css'

// The production Chat and store talk to a real local HTTP/SSE server. Its
// deterministic transcript is a transport/scroll fixture, never a model run.
function Harness() {
  const demo = useDemo()
  const conversation = demo.conversations['transport-chat']
  useLayoutEffect(() => {
    window.transportHarness = {
      snapshot: () => JSON.parse(JSON.stringify({ connection: demo.connection, conversation })),
    }
  })
  return (
    <TooltipProvider>
      <div
        className="workbench-demo-app"
        style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'minmax(0, 1fr)' }}
      >
        <div data-testid="transport-state" data-state={demo.connection} hidden />
        {conversation && (
          <Chat
            conversation={conversation}
            project={{ id: 'transport-project', name: '本地受控验收', environments: [] }}
            agent={{ id: 'fixture', capabilities: ['steer'] }}
            user={demo.user}
            connection={demo.connection}
            api={demo.api}
            command={demo.command}
            refresh={demo.readConversation}
            onPreview={() => {}}
            onContentLink={() => {}}
            onOpenHistory={() => {}}
            onOpenContext={() => {}}
            onMore={() => {}}
            onSelectConversation={() => {}}
          />
        )}
      </div>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')).render(<Harness />)
