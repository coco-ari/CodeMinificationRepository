import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'
import { createRequire } from 'node:module'
import { thirdPartyLicensesPlugin } from './vendor/t3code/scripts/lib/third-party-licenses'

const t3WebRoot = fileURLToPath(new URL('./vendor/t3code/apps/web', import.meta.url))
const t3Require = createRequire(new URL('./vendor/t3code/apps/web/package.json', import.meta.url))
const { tanstackRouter } = await import(pathToFileURL(t3Require.resolve('@tanstack/router-plugin/vite')).href)
const t3RuntimeModule = 'virtual:autoops-t3-runtime'
const t3HostModule = 'virtual:autoops-t3-host'

function mountWorkbenchEntry(server: Pick<ViteDevServer, 'middlewares'>) {
  server.middlewares.use((request, _response, next) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      request.url = '/agent-demo.html' + request.url.slice(1)
    }
    next()
  })
}

export default defineConfig({
  root: 'web',
  plugins: [
    thirdPartyLicensesPlugin({
      bundleName: 'web',
      configFile: new URL('./vendor/t3code/third-party-licenses.config.json', import.meta.url),
      packageManifests: [
        { bundle: 'web', path: new URL('./package.json', import.meta.url) },
        { bundle: 'web', path: new URL('./vendor/t3code/apps/web/package.json', import.meta.url) },
        {
          bundle: 'server',
          path: new URL('./vendor/t3code/apps/server/package.json', import.meta.url),
        },
      ],
    }),
    {
      name: 'autoops-t3-runtime',
      configureServer: mountWorkbenchEntry,
      configurePreviewServer: mountWorkbenchEntry,
      resolveId(id) {
        if (id === t3RuntimeModule || id === t3HostModule) return '\0' + id
      },
      load(id) {
        if (id === '\0' + t3HostModule)
          return [
            `export { installAutoOpsHost } from ${JSON.stringify(t3WebRoot + '/src/autoops/hostConfig.ts')};`,
            ...['Button', 'Input', 'Label', 'Skeleton'].map(
              (name) =>
                `export { ${name} } from ${JSON.stringify(t3WebRoot + '/src/components/ui/' + name.toLowerCase() + '.tsx')};`,
            ),
          ].join('\n')
        if (id !== '\0' + t3RuntimeModule) return
        // 上游保持独立类型工程，真实路由与运行时统一打入同源工作台入口。
        return [
          `export { AppRoot } from ${JSON.stringify(t3WebRoot + '/src/AppRoot.tsx')};`,
          `export { getRouter, createHashHistory } from ${JSON.stringify(t3WebRoot + '/src/router.ts')};`,
          `import ${JSON.stringify(t3WebRoot + '/src/index.css')};`,
          `import ${JSON.stringify(t3WebRoot + '/src/autoops/theme.css')};`,
        ].join('\n')
      },
    },
    tanstackRouter({
      target: 'react',
      routesDirectory: t3WebRoot + '/src/routes',
      generatedRouteTree: t3WebRoot + '/src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      '~': t3WebRoot + '/src',
    },
    dedupe: ['react', 'react-dom'],
  },
  define: {
    'import.meta.env.APP_VERSION': JSON.stringify('0.1.1-autoops'),
    'import.meta.env.VITE_HTTP_URL': JSON.stringify(''),
    'import.meta.env.VITE_WS_URL': JSON.stringify(''),
    'import.meta.env.VITE_T3CODE_RELAY_URL': JSON.stringify(''),
    'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(''),
    'import.meta.env.VITE_RELAY_OTLP_TRACES_URL': JSON.stringify(''),
    'import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET': JSON.stringify(''),
    'import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN': JSON.stringify(''),
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        agentDemo: fileURLToPath(new URL('./web/agent-demo.html', import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      '/api/agent-demo': { target: 'http://127.0.0.1:8787', ws: true },
      '/api': 'http://127.0.0.1:8080',
      '/install': 'http://127.0.0.1:8080',
    },
  },
})
