import { test, expect, vi } from 'vitest'
import { fetchWithOutboundUrlPolicy } from '../security/outbound-url-policy.js'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'

test('pinned fetch releases sockets after consumption and redirect cancellation', async () => {
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/final' }); response.end('redirect body') }
    else response.end('fixture')
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  const policy = { allowHttp: true, allowedIpAddresses: ['127.0.0.1'], lookup: async () => [{ address: '127.0.0.1', family: 4 }] }
  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetchWithOutboundUrlPolicy(`http://audit-fixture.invalid:${address.port}/redirect`, {}, { policy })
      expect(await response.text()).toBe('fixture')
    }
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 2000 })
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
