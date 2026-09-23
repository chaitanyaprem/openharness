import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { LiveEvent } from '../../lib/normalize.js'
import { PiNormalizer } from '../pi/normalizer.js'
import {
  OmpNormalizer,
  lastOmpTurnText,
  ompMessagesToEvents,
  ompPromptLabel,
  ompSessionMeta,
  ompToolName,
  windowOmpLines,
} from './normalizer.js'

// A REAL omp session (omp 18.2.6), first 181 lines, with every string that is not structure replaced.
// It holds: plain user turns, a turn opened by a skill (no user record), a `task` sub-agent call,
// a compaction, a `session_exit`, two aborted turns, and a `title_change`.
const FIXTURE = join(fileURLToPath(new URL('../../lib/__fixtures__', import.meta.url)), 'omp-session.jsonl')
const LINES = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
const SKILL_LINE = LINES.findIndex((line) => line.includes('"customType":"skill-prompt"'))

function live(lines: string[]): { normalizer: OmpNormalizer; events: LiveEvent[] } {
  const normalizer = new OmpNormalizer('live')
  return { normalizer, events: lines.flatMap((line) => normalizer.ingest(line)) }
}

function turnMarkers(events: LiveEvent[]): string[] {
  return events.filter((e) => e.type === 'turn_started' || e.type === 'turn_ended').map((e) => e.type)
}

describe('OmpNormalizer on a recorded session', () => {
  it('opens a turn for a skill prompt, which has no user record in front of it', () => {
    const { events } = live(LINES)
    const skillTurn = events.find((e) => e.type === 'turn_started' && e.payload.userMessage === '/skill:example-skill')
    expect(skillTurn).toBeDefined()
  })

  it('pi\'s reader, given the same file, never sees that turn', () => {
    const pi = new PiNormalizer('live')
    const events = LINES.flatMap((line) => pi.ingest(line))
    expect(events.some((e) => e.type === 'turn_started' && String(e.payload.userMessage).includes('skill'))).toBe(false)
  })

  it('alternates turn start and end, and leaves only the last turn open', () => {
    const { normalizer, events } = live(LINES)
    const markers = turnMarkers(events)
    for (let i = 0; i < markers.length; i++) {
      expect(markers[i], `marker ${i}`).toBe(i % 2 === 0 ? 'turn_started' : 'turn_ended')
    }
    // The recording stops mid-turn (a user line, then tool calls): exactly one turn is still open.
    expect(markers.at(-1)).toBe('turn_started')
    expect(normalizer.turnOpen).toBe(true)
  })

  it('closes an aborted turn', () => {
    const aborted = LINES.findIndex((line) => line.includes('"stopReason":"aborted"'))
    const { normalizer } = live(LINES.slice(0, aborted + 1))
    expect(normalizer.turnOpen).toBe(false)
  })

  it('pairs every tool start with its end and maps omp tool names', () => {
    const { events } = live(LINES)
    const starts = events.filter((e) => e.type === 'tool_start')
    const ends = events.filter((e) => e.type === 'tool_end')
    expect(starts.length).toBeGreaterThan(0)
    expect(new Set(ends.map((e) => e.payload.id))).toEqual(new Set(starts.map((e) => e.payload.id)))
    const tools = new Set(starts.map((e) => e.payload.tool))
    expect(tools).toEqual(new Set(['Bash', 'Task', 'Read', 'Job', 'Irc', 'Glob']))
  })

  it('replays the skill prompt as the turn\'s message', () => {
    const events = ompMessagesToEvents(LINES)
    expect(events).toContainEqual({ type: 'user_message', payload: { content: '/skill:example-skill' } })
    expect(events.at(-1)).toEqual({ type: 'done', payload: { result: 'success' } })
  })

  it('reads the session id and cwd from the header on line 2, after the title', () => {
    expect(ompSessionMeta(LINES)).toEqual({ id: '019f4ced-d053-7000-a56e-218958cd52c4', cwd: '/Users/user/Code' })
  })

  it('snaps a history window back to a turn opened by a skill prompt', () => {
    const window = windowOmpLines(LINES, { limit: 2, before: `omp:${SKILL_LINE + 2}` })
    expect(window.oldestCursor).toBe(`omp:${SKILL_LINE}`)
    expect(windowOmpLines(LINES, { limit: 5, before: 'pi:3' }).staleCursor).toBe(true)
  })
})

describe('OmpNormalizer, single cases', () => {
  const user = (text: string): string =>
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
  const exit = JSON.stringify({ type: 'custom', customType: 'session_exit' })
  const irc = JSON.stringify({ type: 'custom_message', customType: 'irc:incoming', display: true, content: 'ping from Scout\nmore' })
  const hidden = JSON.stringify({ type: 'custom_message', customType: 'xdev-mount-notice', display: false, content: 'x' })

  it('closes a turn left open when omp exits', () => {
    const normalizer = new OmpNormalizer('live')
    normalizer.ingest(user('go'))
    expect(normalizer.ingest(exit)).toEqual([{ type: 'turn_ended', payload: {} }])
    expect(normalizer.turnOpen).toBe(false)
    expect(normalizer.ingest(exit)).toEqual([])
  })

  it('lets an incoming agent message wake an idle agent, but not split a running turn', () => {
    const idle = new OmpNormalizer('live')
    expect(idle.ingest(irc)).toEqual([{ type: 'turn_started', payload: { userMessage: 'ping from Scout' } }])
    const busy = new OmpNormalizer('live')
    busy.ingest(user('go'))
    expect(busy.ingest(irc)).toEqual([])
    expect(busy.turnOpen).toBe(true)
  })

  it('ignores custom messages omp does not display', () => {
    expect(new OmpNormalizer('live').ingest(hidden)).toEqual([])
  })

  it('names a skill from details, falling back to the prompt text', () => {
    expect(ompPromptLabel('skill-prompt', 'x', { name: 'mix' })).toBe('/skill:mix')
    expect(ompPromptLabel('skill-prompt', '[IMPORTANT: The user has invoked the "other" skill, …]')).toBe('/skill:other')
  })

  it('maps glob to Glob and capitalises unknown tools', () => {
    expect(ompToolName('glob')).toBe('Glob')
    expect(ompToolName('search_tool_bm25')).toBe('Search_tool_bm25')
  })

  it('uses the skill prompt as the recap\'s question', () => {
    const skill = JSON.stringify({ type: 'custom_message', customType: 'skill-prompt', display: true, content: 'x', details: { name: 'mix' } })
    const answer = JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } })
    expect(lastOmpTurnText([user('first'), skill, answer])).toEqual({ userMessage: '/skill:mix', assistantText: 'done' })
  })
})
