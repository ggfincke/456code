// apps/server/src/provider/acp/CursorTransportFailure.ts
// detects standalone streamed Cursor transport diagnostics

const MAX_LINE_LENGTH = 4_096
const TRANSPORT_ERROR =
  /^Error: (?:RetriableError: .+|ConnectError: \[(?:unavailable|aborted|deadline_exceeded)\].*)$/
const SERVER_ERROR = 'Something went wrong communicating with the server. Please try again.'

interface ReplyState
{
  disqualified: boolean
  failure: string | undefined
}

function consumeLine(state: ReplyState, line: string): void
{
  if (state.disqualified) return
  const text = line.trimEnd()
  if (TRANSPORT_ERROR.test(text) || text === SERVER_ERROR)
  {
    state.failure = text
  }
  else if (text.trim() !== '' && !(state.failure && /^\s+at\s/.test(text)))
  {
    // explanations and code samples may quote the same diagnostic; only classify a transport dump
    state.disqualified = true
    state.failure = undefined
  }
}

/** Tracks a standalone Cursor diagnostic without retaining an entire streamed answer. */
export class CursorTransportFailure
{
  private state: ReplyState = { disqualified: false, failure: undefined }
  private line = ''

  push(text: string): void
  {
    for (const [index, part] of text.split('\n').entries())
    {
      if (this.state.disqualified) return
      if (index > 0)
      {
        consumeLine(this.state, this.line)
        this.line = ''
      }
      if (this.line.length + part.length > MAX_LINE_LENGTH)
      {
        this.state.disqualified = true
        this.state.failure = undefined
        this.line = ''
        return
      }
      this.line += part
    }
  }

  get failure(): string | undefined
  {
    const state = { ...this.state }
    consumeLine(state, this.line)
    return state.failure
  }
}
