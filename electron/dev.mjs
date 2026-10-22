// `npm run electron:dev`: the Vite dev server (which already sends the
// isolation headers) with Electron pointed at it, hot reload included.
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

const server = await createServer()
await server.listen()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:9000/'
console.log(`Vite on ${url}, starting Electron…`)

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DEV_URL: url }
})
child.on('exit', async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
