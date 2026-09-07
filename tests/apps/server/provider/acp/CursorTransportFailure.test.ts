// tests/apps/server/provider/acp/CursorTransportFailure.test.ts
// verifies standalone Cursor transport diagnostic detection

import { describe, expect, it } from 'vite-plus/test'

import { CursorTransportFailure } from '../../../../../apps/server/src/provider/acp/CursorTransportFailure.ts'

const DIAGNOSTIC = 'Error: RetriableError: WritableIterable is closed'

function failureFor(chunks: ReadonlyArray<string>): string | undefined
{
  const reply = new CursorTransportFailure()
  for (const chunk of chunks) reply.push(chunk)
  return reply.failure
}

describe('CursorTransportFailure', () =>
{
  it.each([
    DIAGNOSTIC,
    'Error: ConnectError: [unavailable] transport closed',
    'Error: ConnectError: [aborted] aborted',
    'Error: ConnectError: [deadline_exceeded] timed out',
    'Something went wrong communicating with the server. Please try again.',
  ])('recognizes a terminal diagnostic: %s', (message) =>
  {
    expect(failureFor([message])).toBe(message)
    expect(failureFor([...message])).toBe(message)
  })

  it('recognizes a standalone failure with a stack trace', () =>
  {
    expect(failureFor(['\n', DIAGNOSTIC, '\n    at send (cli.js:1:2)\n\n'])).toBe(DIAGNOSTIC)
  })

  it.each([
    `The error was ${DIAGNOSTIC}`,
    `This is an example of a transport error:\n${DIAGNOSTIC}`,
    `I inspected the files.\n${DIAGNOSTIC}`,
    `> ${DIAGNOSTIC}`,
    `    ${DIAGNOSTIC}`,
    `\`\`\`text\n${DIAGNOSTIC}\n\`\`\``,
    `~~~\n${DIAGNOSTIC}\n~~~`,
    `${DIAGNOSTIC}\nThis is an example of a transport error.`,
    'Error: ConnectError: [unauthenticated] sign in',
    'Error: ConnectError: [permission_denied] subscription required',
    'Error: HTTP 500 from the application being debugged',
  ])('preserves prose, code, and non-transport errors: %s', (message) =>
  {
    expect(failureFor([...message])).toBeUndefined()
  })

  it('tracks fences across long lines without retaining the answer', () =>
  {
    expect(failureFor(['```\n', 'x'.repeat(100_000), '\n', DIAGNOSTIC])).toBeUndefined()
    expect(failureFor(['```', 'x'.repeat(100_000), '\n', DIAGNOSTIC])).toBeUndefined()
    expect(failureFor(['x'.repeat(100_000), '\n', DIAGNOSTIC])).toBeUndefined()
  })

  it('does not retain a previous failure after new output', () =>
  {
    const reply = new CursorTransportFailure()
    reply.push(DIAGNOSTIC)
    expect(reply.failure).toBe(DIAGNOSTIC)
    reply.push('\nRecovered successfully.')
    expect(reply.failure).toBeUndefined()
  })
})
