import { test, expect } from '@playwright/test'

test.describe('Playground chat streaming', () => {
  test('renders stream deltas and final assistant output from websocket events', async ({ page }) => {
    let runPollCount = 0

    await page.route('**/api/agent-definitions?active=true', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'agent-e2e', name: 'Mock Agent', modelTier: 'chat', active: true },
          ],
        }),
      })
    })

    await page.route('**/api/runs', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'run-e2e',
            agentId: 'agent-e2e',
            status: 'queued',
            startedAt: new Date().toISOString(),
          },
        }),
      })
    })

    await page.route('**/api/runs/run-e2e', async (route) => {
      runPollCount += 1
      const completed = runPollCount >= 2
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'run-e2e',
            agentId: 'agent-e2e',
            status: completed ? 'completed' : 'running',
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: completed ? '2026-01-01T00:00:01.000Z' : undefined,
            output: completed ? { message: 'Hello from e2e stream!' } : null,
          },
        }),
      })
    })

    await page.route('**/api/runs/run-e2e/trace', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            events: [
              { message: 'agent started', phase: 'llm', timestamp: '2026-01-01T00:00:00.500Z' },
            ],
          },
        }),
      })
    })

    await page.routeWebSocket('**/ws', (ws) => {
      ws.onMessage((raw) => {
        try {
          const parsed = JSON.parse(raw)
          if (parsed.type === 'subscribe' && parsed.filter?.runId === 'run-e2e') {
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'agent:stream_delta',
                runId: 'run-e2e',
                agentId: 'agent-e2e',
                content: 'Hello',
                timestamp: new Date().toISOString(),
              }))
            }, 80)

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'agent:stream_delta',
                runId: 'run-e2e',
                agentId: 'agent-e2e',
                content: ' from e2e',
                timestamp: new Date().toISOString(),
              }))
            }, 140)

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'agent:stream_done',
                runId: 'run-e2e',
                agentId: 'agent-e2e',
                finalContent: 'Hello from e2e stream!',
                timestamp: new Date().toISOString(),
              }))
            }, 200)
          }
        } catch {
          // Ignore malformed websocket messages from client.
        }
      })
    })

    await page.goto('/')

    await page.selectOption('#agent-select', 'agent-e2e')
    await page.getByLabel('Chat message input').fill('Please stream')
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByText('Hello from e2e')).toBeVisible()
    await expect(page.getByText('Hello from e2e stream!')).toBeVisible()

    await expect(page.getByText('Run started: run-e2e')).toBeVisible()
  })
})
