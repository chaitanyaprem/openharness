import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import { parseEngineQuestionPane, parseQuestionPane, pollsQuestions, type QuestionView } from '../../lib/askQuestion.js'
import { ompSelectionKeys, parseOmpQuestionPane } from './askQuestion.js'

// Live `tmux capture-pane -p -e` captures from omp 18.2.6, trimmed to the dialog and the lines above it.
const FIXTURES = fileURLToPath(new URL('../../lib/__fixtures__', import.meta.url))
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

function question(capture: string): QuestionView {
  const view = parseOmpQuestionPane(capture)
  if (view?.kind !== 'question') throw new Error('no question parsed')
  return view
}

describe('omp approval prompt', () => {
  it('reads the tool, the command and both choices', () => {
    const view = question(fixture('permission-omp.txt'))
    expect(view.permission).toBe(true)
    expect(view.question).toBe('Allow bash? Command: curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"')
    expect(view.rows.map((r) => r.label)).toEqual(['Approve', 'Deny'])
    expect(view.cursor).toBe(0)
  })

  it('walks from where the cursor is, not from the top', () => {
    // Captured after pressing Down once: the cursor is on Deny.
    const view = question(fixture('permission-omp-deny-selected.txt'))
    expect(view.cursor).toBe(1)
    const [approve, deny] = view.rows
    expect(ompSelectionKeys(deny, view)).toEqual(['Enter'])
    expect(ompSelectionKeys(approve, view)).toEqual(['Up', 'Enter'])
  })

  it('is walked from the first row when the cursor has not moved', () => {
    const view = question(fixture('permission-omp.txt'))
    expect(ompSelectionKeys(view.rows[0], view)).toEqual(['Enter'])
    expect(ompSelectionKeys(view.rows[1], view)).toEqual(['Down', 'Enter'])
  })

  it('is not something the shared numbered-row parser can read', () => {
    expect(parseQuestionPane(fixture('permission-omp.txt'))).toBeNull()
  })
})

describe('omp ask dialog', () => {
  it('reads the live dialog, not the tool preview drawn above it', () => {
    const view = question(fixture('question-omp.txt'))
    expect(view.permission).toBeUndefined()
    expect(view.question).toBe('Which colour do you prefer?')
    // Descriptions under each option are skipped; "Other (type your own)" opens an editor and is not offered.
    expect(view.rows.map((r) => r.label)).toEqual(['Red', 'Green', 'Blue'])
    expect(view.cursor).toBe(0)
    expect(view.typeRow).toBeNull()
    expect(ompSelectionKeys(view.rows[1], view)).toEqual(['Down', 'Enter'])
  })
})

describe('omp dialogs through the shared entry points', () => {
  it('routes omp to its own parser and watches its pane', () => {
    expect(parseEngineQuestionPane('omp', fixture('permission-omp.txt'))).toMatchObject({ kind: 'question', permission: true })
    expect(pollsQuestions('omp')).toBe(true)
  })

  it('leaves dialogs it has never seen to the pane', () => {
    const toggle = fixture('question-omp.txt').replace('Enter select · n note · ↑/↓ move', 'up/down navigate  enter toggle  esc cancel')
    expect(parseOmpQuestionPane(toggle)).toBeNull()
    expect(parseOmpQuestionPane('plain terminal output\n$ ls\n')).toBeNull()
  })
})
