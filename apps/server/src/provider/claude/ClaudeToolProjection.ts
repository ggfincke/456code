// apps/server/src/provider/claude/ClaudeToolProjection.ts
// projects Claude tools and tasks into canonical runtime views

import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimeContentStreamKind,
} from '@t3tools/contracts'

import { encodeJsonStringForDiagnostics } from './ClaudeSdkMessages.ts'

type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  'command_output' | 'file_change_output'
>

export type PlanStep = {
  readonly step: string
  readonly status: 'pending' | 'inProgress' | 'completed'
}

export function classifyToolItemType(toolName: string): CanonicalItemType
{
  const normalized = toolName.toLowerCase()
  if (normalized.includes('agent'))
  {
    return 'collab_agent_tool_call'
  }
  if (
    normalized === 'task' ||
    normalized === 'agent' ||
    normalized.includes('subagent') ||
    normalized.includes('sub-agent')
  )
  {
    return 'collab_agent_tool_call'
  }
  if (
    normalized.includes('bash') ||
    normalized.includes('command') ||
    normalized.includes('shell') ||
    normalized.includes('terminal')
  )
  {
    return 'command_execution'
  }
  if (
    normalized.includes('edit') ||
    normalized.includes('write') ||
    normalized.includes('file') ||
    normalized.includes('patch') ||
    normalized.includes('replace') ||
    normalized.includes('create') ||
    normalized.includes('delete')
  )
  {
    return 'file_change'
  }
  if (normalized.includes('mcp'))
  {
    return 'mcp_tool_call'
  }
  if (normalized.includes('websearch') || normalized.includes('web search'))
  {
    return 'web_search'
  }
  if (normalized.includes('image'))
  {
    return 'image_view'
  }
  return 'dynamic_tool_call'
}

function isReadOnlyToolName(toolName: string): boolean
{
  const normalized = toolName.toLowerCase()
  return (
    normalized === 'read' ||
    normalized.includes('read file') ||
    normalized.includes('view') ||
    normalized.includes('grep') ||
    normalized.includes('glob') ||
    normalized.includes('search')
  )
}

export function classifyRequestType(toolName: string): CanonicalRequestType
{
  if (isReadOnlyToolName(toolName))
  {
    return 'file_read_approval'
  }
  const itemType = classifyToolItemType(toolName)
  return itemType === 'command_execution'
    ? 'command_execution_approval'
    : itemType === 'file_change'
      ? 'file_change_approval'
      : 'dynamic_tool_call'
}

export function isTodoTool(toolName: string): boolean
{
  return toolName.toLowerCase().includes('todowrite')
}

export function extractPlanStepsFromTodoInput(
  input: Readonly<Record<string, unknown>>,
): Array<PlanStep> | null
{
  const todos = input.todos
  if (!Array.isArray(todos) || todos.length === 0)
  {
    return null
  }
  return todos
    .filter((todo): todo is Record<string, unknown> => todo !== null && typeof todo === 'object')
    .map((todo) => ({
      step:
        typeof todo.content === 'string' && todo.content.trim().length > 0
          ? todo.content.trim()
          : 'Task',
      status:
        todo.status === 'completed'
          ? 'completed'
          : todo.status === 'in_progress'
            ? 'inProgress'
            : 'pending',
    }))
}

export function isClaudeTaskTool(toolName: string): boolean
{
  return toolName === 'TaskCreate' || toolName === 'TaskUpdate' || toolName === 'TaskList'
}

export function normalizeClaudeTaskStatus(value: unknown): PlanStep['status']
{
  return value === 'completed' ? 'completed' : value === 'in_progress' ? 'inProgress' : 'pending'
}

export function readString(value: unknown): string | undefined
{
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function readStringArray(value: unknown): Array<string>
{
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

export function readClaudeTaskFromResult(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined
{
  const task = result?.task
  return task !== null && typeof task === 'object' && !Array.isArray(task)
    ? (task as Record<string, unknown>)
    : undefined
}

export function planStepsFromClaudeTasks(
  tasks: ReadonlyMap<
    string,
    {
      readonly subject: string
      readonly status: PlanStep['status']
      readonly blockedBy: ReadonlySet<string>
    }
  >,
): Array<PlanStep>
{
  return Array.from(tasks.values()).map((task) =>
  {
    const blockedBy = Array.from(task.blockedBy)
    const blockedSuffix = blockedBy.length > 0 ? ` (blocked by #${blockedBy.join(', #')})` : ''
    return {
      step: `${task.subject}${blockedSuffix}`,
      status: task.status,
    }
  })
}

export function summarizeToolRequest(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): string
{
  const commandValue = input.command ?? input.cmd
  const command = typeof commandValue === 'string' ? commandValue : undefined
  if (command && command.trim().length > 0)
  {
    return `${toolName}: ${command.trim().slice(0, 400)}`
  }

  // prefer a human-readable agent description or prompt over raw JSON
  const itemType = classifyToolItemType(toolName)
  if (itemType === 'collab_agent_tool_call')
  {
    const description = typeof input.description === 'string' ? input.description.trim() : undefined
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : undefined
    const subagentType =
      typeof input.subagent_type === 'string' ? input.subagent_type.trim() : undefined
    const label = description || (prompt ? prompt.slice(0, 200) : undefined)
    if (label)
    {
      return subagentType ? `${subagentType}: ${label}` : label
    }
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? '[unserializable input]'
  if (serialized.length <= 400)
  {
    return `${toolName}: ${serialized}`
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`
}

export function titleForTool(itemType: CanonicalItemType): string
{
  switch (itemType)
  {
    case 'command_execution':
      return 'Command run'
    case 'file_change':
      return 'File change'
    case 'mcp_tool_call':
      return 'MCP tool call'
    case 'collab_agent_tool_call':
      return 'Subagent task'
    case 'web_search':
      return 'Web search'
    case 'image_view':
      return 'Image view'
    case 'dynamic_tool_call':
      return 'Tool call'
    default:
      return 'Item'
  }
}

export function extractExitPlanModePlan(value: unknown): string | undefined
{
  if (!value || typeof value !== 'object')
  {
    return undefined
  }

  const record = value as {
    plan?: unknown
  }
  return typeof record.plan === 'string' && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined
  readonly planMarkdown: string
}): string
{
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined
{
  switch (itemType)
  {
    case 'command_execution':
      return 'command_output'
    case 'file_change':
      return 'file_change_output'
    default:
      return undefined
  }
}
