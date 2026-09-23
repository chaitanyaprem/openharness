/**
 * Oh My Pi's two dialogs: the tool approval prompt and the `ask` tool's question. Both captured live
 * from omp 18.2.6 in tmux (`lib/__fixtures__/permission-omp*.txt`, `question-omp.txt`):
 *
 *   +- Allow tool: bash ----------------------------------+
 *   |                                                     |
 *   | Command: curl -s "https://api.coingecko.com/…"      |   ← what is being approved
 *   |                                                     |
 *   |  > Approve                                          |   ← `>` is the cursor; rows are NOT numbered
 *   |    Deny                                             |
 *   |                                                     |
 *   | up/down navigate  enter select  esc cancel          |
 *   +-----------------------------------------------------+
 *
 *   +- Ask -----------------------------------------------+
 *   | Which colour do you prefer?                         |
 *   +-----------------------------------------------------+
 *   | > ( ) Red                                           |
 *   |       Long-wavelength primary; warm, high-arousal.  |   ← a description line under each option
 *   |   ( ) Green                                         |
 *   |   …                                                 |
 *   |   ( ) Other (type your own)                         |   ← free text
 *   +-----------------------------------------------------+
 *   | Enter select · n note · ↑/↓ move · Esc cancel       |
 *   +-----------------------------------------------------+
 *
 * Measured behaviour:
 *
 * - **Both are walked, not keyed.** `Down` moves the cursor, `Enter` selects AND submits. Approving and
 *   denying were each driven that way on the live prompt; so was picking an `ask` option.
 * - **The approval rows are fixed.** omp's binary builds that dialog in two places, both
 *   `select(…, ["Approve", "Deny"])`, so the parser accepts exactly those two labels.
 * - **omp draws the boxes in ASCII** (`+-`, `|`) under tmux. Unicode borders are accepted too.
 * - **The walk starts at the cursor, not the top.** Amp's and Kilo's walks assume the list opens on its
 *   first row. omp's does too, but it draws the cursor, and a person may move it in the pane before the
 *   device answers; walking by index from there would approve when the device said deny.
 * - **An `ask` call is echoed above its dialog** as a tool preview (`+--- Ask 1 questions ---`, the same
 *   options without a cursor). The parser anchors on the LAST footer and the exact `Ask` title.
 *
 * Not handled, because none was measured: the multi-select variant (`enter toggle`), a multi-question
 * `ask` (`←/→ question`), and typing into "Other". Those dialogs return null and stay pane-only.
 */

import type { PaneView, QuestionRow, QuestionView } from '../../lib/askQuestion.js'

const APPROVAL_FOOTER_RE = /up\/down navigate\s+enter select/i
const ASK_FOOTER_RE = /enter select\b.*↑\/↓ move/i
/** Footers of dialogs this parser does not claim: checkboxes and multi-question pages. */
const UNMEASURED_FOOTER_RE = /enter toggle|←\/→ question/i

const APPROVAL_TITLE_RE = /^[+╭┌][-─]+\s*Allow tool:\s*(\S+)\s*[-─]/
const ASK_TITLE_RE = /^[+╭┌][-─]+\s*Ask\s*[-─]{2,}/
/** A border row: `+-----+` or `├──────┤`, the separator between the question and its options. */
const RULE_RE = /^[+├╰└╭┌][-─]{3,}/

const APPROVAL_LABELS = new Set(['Approve', 'Deny'])
const APPROVAL_ROW_RE = /^\s*(>)?\s*(Approve|Deny)\s*$/
/** `> ( ) Red` or `  (o) Green`: the cursor, then a radio marker, then the label. */
const ASK_ROW_RE = /^\s*(>)?\s*\([ o*x•]\)\s+(.+?)\s*$/
const OTHER_ROW_RE = /^other \(type your own\)$/i

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;:?]*[A-Za-z]/g, '')
}

/** The line inside the box: drop the left border and the right one, keep the indentation. */
function unbox(line: string): string {
  return line.replace(/^\s*[|│┃]/, '').replace(/[|│┃]\s*$/, '').trimEnd()
}

/**
 * The keystrokes that pick `row`: walk from the cursor to it, then commit. `number` carries the row's
 * index, and `view.cursor` where the cursor is now.
 */
export function ompSelectionKeys(row: QuestionRow, view?: QuestionView): string[] {
  const target = Number(row.number)
  const from = view?.cursor ?? 0
  if (!Number.isInteger(target) || target < 0) return ['Enter']
  const steps = target - from
  return [...Array(Math.abs(steps)).fill(steps > 0 ? 'Down' : 'Up'), 'Enter']
}

function rowsFrom(labels: string[]): QuestionRow[] {
  return labels.map((label, index) => ({ number: String(index), label, checked: false, walk: 'down' as const }))
}

function parseApproval(tool: string, body: string[]): QuestionView | null {
  const labels: string[] = []
  let cursor = 0
  const subject: string[] = []
  for (const line of body) {
    const row = APPROVAL_ROW_RE.exec(line)
    if (row) {
      if (row[1]) cursor = labels.length
      labels.push(row[2])
      continue
    }
    if (line.trim() && !labels.length) subject.push(line.trim())
  }
  if (labels.length !== APPROVAL_LABELS.size || !labels.every((label) => APPROVAL_LABELS.has(label))) return null
  // The subject goes into the question: "Approve" alone gives nobody anything to judge.
  const what = subject.join(' ')
  return {
    kind: 'question',
    permission: true,
    question: what ? `Allow ${tool}? ${what}` : `Allow ${tool}?`,
    rows: rowsFrom(labels),
    multi: false,
    typeRow: null,
    cursor,
  }
}

function parseAsk(body: string[]): QuestionView | null {
  const rule = body.findIndex((line) => RULE_RE.test(line.trim()))
  if (rule < 0) return null
  const question = body.slice(0, rule).map((line) => line.trim()).filter(Boolean).join(' ')
  const labels: string[] = []
  let cursor = 0
  for (const line of body.slice(rule + 1)) {
    const row = ASK_ROW_RE.exec(line)
    if (!row) continue // a description line under an option, or padding
    const label = row[2]
    // Picking "Other" opens an editor; the device cannot type into it, so it is not offered.
    if (OTHER_ROW_RE.test(label)) continue
    if (row[1]) cursor = labels.length
    labels.push(label)
  }
  if (!question || labels.length < 1) return null
  return { kind: 'question', question, rows: rowsFrom(labels), multi: false, typeRow: null, cursor }
}

export function parseOmpQuestionPane(capture: string): PaneView {
  const raw = stripAnsi(capture).split('\n')
  // The LAST footer: an answered dialog or the `ask` preview can still be in the scrollback above.
  let footer = -1
  for (let i = raw.length - 1; i >= 0; i--) {
    const line = unbox(raw[i])
    if (APPROVAL_FOOTER_RE.test(line) || ASK_FOOTER_RE.test(line)) { footer = i; break }
  }
  if (footer < 0 || UNMEASURED_FOOTER_RE.test(raw[footer])) return null

  for (let i = footer - 1; i >= 0 && footer - i < 60; i--) {
    const line = raw[i].trim()
    const approval = APPROVAL_TITLE_RE.exec(line)
    if (approval) return parseApproval(approval[1], raw.slice(i + 1, footer).map(unbox))
    if (ASK_TITLE_RE.test(line)) {
      // The ask footer sits in its own box row below the options; drop the rule above it.
      const body = raw.slice(i + 1, footer).map(unbox)
      while (body.length && (!body[body.length - 1].trim() || RULE_RE.test(body[body.length - 1].trim()))) body.pop()
      return parseAsk(body)
    }
  }
  return null
}
