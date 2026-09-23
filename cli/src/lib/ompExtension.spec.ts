import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The Oh My Pi discovery extension, run the way omp runs it: its default export is handed an API with
 * `on(event, handler)`, and each handler gets a `ctx`. The fake API below has exactly the members the
 * extension uses, which omp 18.2.6 exposes under the same names (checked in its binary and in herdr's
 * omp extension).
 */

const root = mkdtempSync(join(tmpdir(), 'omp-extension-'))
type Handler = (event: unknown, ctx: unknown) => Promise<void>

let extension: (api: { on: (event: string, handler: Handler) => void }) => void

beforeAll(async () => {
  process.env.OMP_HOME = join(root, 'omp')
  process.env.ADAPTER_DATA_DIR = join(root, 'data')
  mkdirSync(process.env.ADAPTER_DATA_DIR, { recursive: true })
  writeFileSync(join(process.env.ADAPTER_DATA_DIR, 'hook-credential'), 'hook-token\n')
  vi.resetModules()
  const { installOmpExtension } = await import('./hooks.js')
  installOmpExtension(18473)
  extension = (await import(join(root, 'omp', 'agent', 'extensions', 'launcher-register.ts'))).default
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

afterAll(() => {
  delete process.env.OMP_HOME
  delete process.env.ADAPTER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

function load(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  extension({ on: (event, handler) => { handlers[event] = handler } })
  return handlers
}

function ctx(opts: { hasUI: boolean; id: string; file: string | null }) {
  return {
    hasUI: opts.hasUI,
    cwd: '/work',
    sessionManager: { getSessionId: () => opts.id, getSessionFile: () => opts.file },
  }
}

function recordPosts() {
  const posts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body) as Record<string, unknown>)
    return new Response('{}', { status: 200 })
  }))
  return posts
}

describe('Oh My Pi discovery extension', () => {
  it('registers the root session as an omp session for its pane', async () => {
    vi.stubEnv('TMUX_PANE', '%7')
    const posts = recordPosts()
    const transcript = join(root, 'main.jsonl')
    writeFileSync(transcript, '')
    await load().session_start({}, ctx({ hasUI: true, id: 'root-1', file: transcript }))
    expect(posts).toEqual([expect.objectContaining({ engine: 'omp', sessionId: 'root-1', transcriptPath: transcript, tmuxPane: '%7' })])
  })

  it('never registers a sub-agent or print-mode run, which have no UI', async () => {
    vi.stubEnv('TMUX_PANE', '%7')
    const posts = recordPosts()
    const handlers = load()
    for (const event of ['session_start', 'turn_start', 'turn_end']) {
      await handlers[event]({}, ctx({ hasUI: false, id: 'sub-agent', file: null }))
    }
    expect(posts).toEqual([])
  })

  it('registers again when the process switches to another session', async () => {
    vi.stubEnv('TMUX_PANE', '%7')
    const posts = recordPosts()
    const first = join(root, 'first.jsonl')
    const second = join(root, 'second.jsonl')
    writeFileSync(first, '')
    writeFileSync(second, '')
    const handlers = load()
    await handlers.session_start({}, ctx({ hasUI: true, id: 'first', file: first }))
    await handlers.turn_end({}, ctx({ hasUI: true, id: 'first', file: first })) // already registered: silent
    await handlers.session_switch({}, ctx({ hasUI: true, id: 'second', file: second }))
    expect(posts.map((p) => p.sessionId)).toEqual(['first', 'second'])
  })

  it('does nothing outside a tmux or herdr pane', async () => {
    vi.stubEnv('TMUX_PANE', '')
    vi.stubEnv('HERDR_PANE_ID', '')
    const posts = recordPosts()
    await load().session_start({}, ctx({ hasUI: true, id: 'root-1', file: null }))
    expect(posts).toEqual([])
  })
})
