/**
 * Oh My Pi (omp, pi's fork) JSONL → shared event vocabulary.
 *
 * A deliberate copy of engines/pi/normalizer.ts, not a shared abstraction: the fork is free to drift,
 * and this file is where that drift lands. Measured against real sessions (omp 18.2.6, 10 main
 * transcripts + 2 sub-agent transcripts):
 *
 *   line 1  {"type":"title","v":1,"title":"…","pad":"   …"}   padded so omp can rewrite it in place
 *   line 2  {"type":"session","version":3,"id":"<uuidv7>","cwd":"/abs/path"}
 *   then    {"type":"message","message":{…}}   same roles and parts as pi
 *           {"type":"custom","customType":"tool_execution_start"|"session_exit"}
 *           {"type":"custom_message","customType":"skill-prompt"|"irc:incoming"|…,"display":bool,"content":…}
 *           {"type":"model_change"|"thinking_level_change"|"title_change"|"compaction"|…}
 *
 * Where omp differs from pi, and what a straight copy would have got wrong:
 *
 * - **A turn can start without a user message.** Invoking a skill writes a displayed
 *   `custom_message` (customType `skill-prompt`) and the assistant answers it; no `user` record comes
 *   first. Pi's rule (only a user message opens a turn) left that whole turn invisible. A displayed
 *   custom message now opens a turn when none is open. `irc:incoming` (a message from another agent)
 *   wakes an idle agent the same way.
 * - **Leaving omp is recorded.** `custom` `session_exit` closes a turn that was still open, so quitting
 *   mid-turn does not pin the tile on Processing.
 * - **Tool names.** omp adds `glob`, `ask`, `eval`, `job`, `irc`, `yield` and MCP tools.
 *
 * Stop reasons measured: `stop`, `toolUse`, `aborted`, so pi's rule (anything but `toolUse` ends the
 * turn) holds. `custom` `tool_execution_start` duplicates each toolCall and is ignored.
 */

import type { EngineNormalizer } from '../types.js'
import type { LastTurnText, LiveEvent, SessionEvent } from '../../lib/normalize.js'

type JsonObject = Record<string, unknown>

const MAX_OUTPUT = 2_000
const MAX_THINKING = 500
const MAX_PROMPT_LABEL = 200

/** omp's built-in tools are lowercase; map them onto the vocabulary the web/device cards render. */
const TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  find: 'Glob',
  ls: 'LS',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  task: 'Task',
}

export function ompToolName(name: string): string {
  const key = name.toLowerCase()
  if (TOOL_NAMES[key]) return TOOL_NAMES[key]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'tool'
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parse(line: string): JsonObject | null {
  try { return object(JSON.parse(line)) } catch { return null }
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…[truncated]` : value
}

/** `content` is either a plain string or an array of typed parts — flatten the text of both. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = object(part)
      return p && p.type === 'text' ? str(p.text) : ''
    })
    .filter(Boolean)
    .join('')
}

function contentParts(content: unknown): JsonObject[] {
  if (Array.isArray(content)) return content.map(object).filter((p): p is JsonObject => p !== null)
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

function toolSummary(name: string, output: string, isError: boolean): string {
  const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (isError) return first ? `${name} failed: ${first}` : `${name} failed`
  return first || `${name} completed`
}

function compactEvent(): LiveEvent {
  return {
    type: 'context_compact',
    payload: { message: 'Context was compacted — the previous conversation has been summarized to free up space.' },
  }
}

/** A turn ends on any stop reason other than `toolUse` (which means the assistant is calling a tool). */
function isTerminalStop(stopReason: string): boolean {
  return !!stopReason && stopReason !== 'toolUse'
}

/**
 * What a displayed custom message stands for, as the prompt of the turn it opens. A skill prompt is a
 * long injected instruction ("[IMPORTANT: The user has invoked the "<name>" skill, …"), so it is shown
 * by its skill name, which omp also records in `details.name`; anything else by its first line.
 */
export function ompPromptLabel(customType: string, content: unknown, details?: unknown): string {
  const text = contentText(content).trim()
  if (customType === 'skill-prompt') {
    const skill = str(object(details)?.name) || /invoked the "([^"]+)" skill/.exec(text)?.[1]
    if (skill) return `/skill:${skill}`
  }
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  return first.length > MAX_PROMPT_LABEL ? `${first.slice(0, MAX_PROMPT_LABEL)}…` : first
}

/** A `custom_message` omp shows in its own UI, as a prompt label; null when it is hidden or empty. */
function displayedPrompt(raw: JsonObject): string | null {
  if (raw.display !== true) return null
  const label = ompPromptLabel(str(raw.customType), raw.content, raw.details)
  return label || null
}

export class OmpNormalizer implements EngineNormalizer {
  private open = false
  private pendingTools = new Set<string>()
  private toolNames = new Map<string, string>()
  private thinkingCounter = 0

  constructor(private readonly mode: 'live' | 'replay') {}

  get turnOpen(): boolean { return this.open }

  closeTurn(): void { this.open = false; this.pendingTools.clear() }

  ingest(line: string): LiveEvent[] {
    const raw = parse(line)
    if (!raw) return []
    const type = str(raw.type)
    if (type === 'compaction') return [compactEvent()]
    if (type === 'custom_message') return this.customMessage(raw)
    if (type === 'custom') return str(raw.customType) === 'session_exit' ? this.sessionExit() : []
    if (type !== 'message') return [] // title, session header, model_change, thinking_level_change, …
    const message = object(raw.message)
    if (!message) return []

    const role = str(message.role)
    if (role === 'user') return this.userMessage(message)
    if (role === 'assistant') return this.assistantMessage(message)
    if (role === 'toolResult') return this.toolResult(message)
    if (role === 'bashExecution') return this.bashExecution(raw, message)
    return []
  }

  finishReplay(): LiveEvent[] {
    return this.mode === 'replay' ? [{ type: 'done', payload: { result: 'success' } }] : []
  }

  private userMessage(message: JsonObject): LiveEvent[] {
    const text = contentText(message.content).trim()
    if (!text) return []
    return this.startTurn(text, true)
  }

  /** A skill prompt or an incoming agent message: it opens a turn, but never ends one already running. */
  private customMessage(raw: JsonObject): LiveEvent[] {
    const label = displayedPrompt(raw)
    if (!label) return []
    if (this.mode !== 'replay' && this.open) return []
    return this.startTurn(label, false)
  }

  private startTurn(text: string, closesOpenTurn: boolean): LiveEvent[] {
    if (this.mode === 'replay') return [{ type: 'user_message', payload: { content: text } }]
    const events: LiveEvent[] = []
    if (this.open && closesOpenTurn) events.push({ type: 'turn_ended', payload: {} })
    this.open = true
    this.pendingTools.clear()
    events.push({ type: 'turn_started', payload: { userMessage: text } })
    return events
  }

  private sessionExit(): LiveEvent[] {
    if (this.mode === 'replay' || !this.open) return []
    this.closeTurn()
    return [{ type: 'turn_ended', payload: {} }]
  }

  private assistantMessage(message: JsonObject): LiveEvent[] {
    const events: LiveEvent[] = []
    for (const part of contentParts(message.content)) {
      const type = str(part.type)
      if (type === 'thinking') {
        const thinking = str(part.thinking)
        if (!thinking) continue
        events.push({
          type: 'thinking_delta',
          payload: { content: clip(thinking, MAX_THINKING), thinkingId: `thinking-omp-${this.thinkingCounter++}` },
        })
      } else if (type === 'text') {
        const text = str(part.text)
        if (text) events.push({ type: 'text_delta', payload: { content: text } })
      } else if (type === 'toolCall') {
        const id = str(part.id)
        if (!id) continue
        const tool = ompToolName(str(part.name))
        this.toolNames.set(id, tool)
        this.pendingTools.add(id)
        events.push({ type: 'tool_start', payload: { id, tool, input: part.arguments ?? {} } })
      }
    }
    if (this.mode !== 'replay' && this.open && isTerminalStop(str(message.stopReason)) && this.pendingTools.size === 0) {
      this.open = false
      events.push({ type: 'turn_ended', payload: {} })
    }
    return events
  }

  private toolResult(message: JsonObject): LiveEvent[] {
    const id = str(message.toolCallId)
    if (!id) return []
    this.pendingTools.delete(id)
    const tool = this.toolNames.get(id) || ompToolName(str(message.toolName))
    this.toolNames.delete(id)
    const output = contentText(message.content)
    const isError = message.isError === true
    return [{
      type: 'tool_end',
      payload: { id, tool, output: clip(output, MAX_OUTPUT), isError, summary: toolSummary(tool, output, isError) },
    }]
  }

  /** `!cmd` typed directly in the TUI (pi's record; kept in case omp writes it) — a Bash card. */
  private bashExecution(raw: JsonObject, message: JsonObject): LiveEvent[] {
    const command = str(message.command)
    if (!command) return []
    const id = `bash-${str(raw.id) || this.thinkingCounter++}`
    const output = str(message.output)
    const isError = typeof message.exitCode === 'number' && message.exitCode !== 0
    return [
      { type: 'tool_start', payload: { id, tool: 'Bash', input: { command } } },
      {
        type: 'tool_end',
        payload: { id, tool: 'Bash', output: clip(output, MAX_OUTPUT), isError, summary: toolSummary('Bash', output, isError) },
      },
    ]
  }
}

/** Full-session replay (session_get) — same render path as the live stream. */
export function ompMessagesToEvents(rawLines: string[]): SessionEvent[] {
  const normalizer = new OmpNormalizer('replay')
  const events: SessionEvent[] = []
  for (const line of rawLines) events.push(...normalizer.ingest(line) as SessionEvent[])
  events.push(...normalizer.finishReplay() as SessionEvent[])
  return events
}

/** Last prompt (user or displayed custom message) + the assistant text that followed it — the recap source. */
export function lastOmpTurnText(rawLines: string[]): LastTurnText | null {
  let userMessage = ''
  let assistantText = ''
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw) continue
    const type = str(raw.type)
    if (type === 'custom_message') {
      const label = displayedPrompt(raw)
      if (label) { userMessage = label; assistantText = '' }
      continue
    }
    if (type !== 'message') continue
    const message = object(raw.message)
    if (!message) continue
    const role = str(message.role)
    if (role === 'user') {
      const text = contentText(message.content).trim()
      if (text) { userMessage = text; assistantText = '' }
    } else if (role === 'assistant') {
      const text = contentParts(message.content)
        .filter((part) => str(part.type) === 'text')
        .map((part) => str(part.text))
        .join('')
        .trim()
      if (text) assistantText += `${assistantText ? '\n\n' : ''}${text}`
    }
  }
  return assistantText ? { userMessage, assistantText } : null
}

/** Session id + cwd from the header line (line 2, after the title), for registration/repair. */
export function ompSessionMeta(rawLines: string[]): { id: string; cwd: string } | null {
  for (const line of rawLines) {
    const raw = parse(line)
    if (!raw || str(raw.type) !== 'session') continue
    const id = str(raw.id)
    if (id) return { id, cwd: str(raw.cwd) }
  }
  return null
}

function opensTurn(raw: JsonObject | null): boolean {
  if (!raw) return false
  const type = str(raw.type)
  if (type === 'custom_message') return displayedPrompt(raw) !== null
  return type === 'message' && str(object(raw.message)?.role) === 'user'
}

/**
 * Turn-snapped pagination window for `session_get {limit, before}`; cursor format `omp:<lineIndex>`.
 * The start snaps back to a turn's opening line so a window never splits a turn (the replay is
 * stateful: a tool_start's name must still be known when its tool_end is rendered).
 */
export function windowOmpLines(
  rawLines: string[],
  opts: { limit: number; before?: string },
): { window: string[]; hasMore: boolean; oldestCursor: string | null; staleCursor?: boolean } {
  let endIndex = rawLines.length
  if (opts.before) {
    const match = /^omp:(\d+)$/.exec(opts.before)
    if (!match) return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    endIndex = Number(match[1])
    if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex > rawLines.length) {
      return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    }
  }

  let start = Math.max(0, endIndex - opts.limit)
  while (start > 0 && !opensTurn(parse(rawLines[start]))) start--
  return {
    window: rawLines.slice(start, endIndex),
    hasMore: start > 0,
    oldestCursor: `omp:${start}`,
  }
}
