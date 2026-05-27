import { describe, it, expect, vi } from 'vitest'

import {
  ArtifactWatcherHost,
  type ArtifactWatcherHandle,
} from '../base/artifact-watcher-host.js'

describe('ArtifactWatcherHost.watcherActivationStatus', () => {
  it("returns 'not_configured' before a factory is set", () => {
    const host = new ArtifactWatcherHost('claude')
    expect(host.watcherActivationStatus()).toBe('not_configured')
  })

  it("still returns 'not_configured' after wiring a factory but before starting", () => {
    const host = new ArtifactWatcherHost('claude')
    host.setFactory(() => ({ stop: vi.fn() }))
    expect(host.watcherActivationStatus()).toBe('not_configured')
  })

  it("returns 'active' after the watcher is started", () => {
    const host = new ArtifactWatcherHost('claude')
    const handle: ArtifactWatcherHandle = { stop: vi.fn() }
    host.setFactory(() => handle)

    host.start(['/workspace/.adapter/events.jsonl'])

    expect(host.watcherActivationStatus()).toBe('active')
    expect(host.getStatus().state).toBe('active')
  })

  it("returns 'stopped' after stop() is called on a started watcher", () => {
    const host = new ArtifactWatcherHost('claude')
    const stop = vi.fn()
    host.setFactory(() => ({ stop }))

    host.start(['/workspace/.adapter/events.jsonl'])
    expect(host.watcherActivationStatus()).toBe('active')

    host.stop()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(host.watcherActivationStatus()).toBe('stopped')
  })

  it("stays 'not_configured' when the factory was cleared and a watcher never ran", () => {
    const host = new ArtifactWatcherHost('claude')
    host.setFactory(() => ({ stop: vi.fn() }))
    host.setFactory(null)
    expect(host.watcherActivationStatus()).toBe('not_configured')
  })
})
