// apps/web/src/components/settings/keybindings/whenExpression.tsx
// when-expression builder and keybinding search chrome

import {
  ChevronDownIcon,
  CircleXIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type KeybindingWhenNode } from '@t3tools/contracts'

import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Kbd, KbdGroup } from '../../ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Toggle } from '../../ui/toggle'
import { Tooltip, TooltipPopup, TooltipTrigger } from '../../ui/tooltip'
import {
  DEFAULT_WHEN_VARIABLE,
  isKnownWhenVariable,
  parseWhenExpressionDraft,
  type WhenVariableOption,
  unknownWhenVariables,
  whenAstToExpression,
} from '../KeybindingsSettings.logic'

export function KeybindingPill({ value }: { value: string })
{
  const parts = value.split('+')
  return (
    <KbdGroup className="bg-transparent p-0 shadow-none">
      {parts.map((part) => (
        <Kbd key={part} className="min-w-6 justify-center px-1.5">
          {part === 'mod'
            ? navigator.platform.toLowerCase().includes('mac')
              ? '⌘'
              : 'Ctrl'
            : part === 'shift'
              ? '⇧'
              : part === 'alt'
                ? navigator.platform.toLowerCase().includes('mac')
                  ? '⌥'
                  : 'Alt'
                : part === 'ctrl'
                  ? '⌃'
                  : part.length === 1
                    ? part.toUpperCase()
                    : part}
        </Kbd>
      ))}
    </KbdGroup>
  )
}

export function ExpandableHeaderSearch({
  query,
  onChange,
  isOpen,
  onOpenChange,
  inputRef,
  collapsedAccessory,
}: {
  query: string
  onChange: (next: string) => void
  isOpen: boolean
  onOpenChange: (next: boolean) => void
  inputRef?: RefObject<HTMLInputElement | null>
  collapsedAccessory?: ReactNode
})
{
  if (!isOpen)
  {
    return (
      <>
        {collapsedAccessory}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                onClick={() => onOpenChange(true)}
                aria-label="Search keybindings"
              >
                <SearchIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top">Search keybindings</TooltipPopup>
        </Tooltip>
      </>
    )
  }

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        value={query}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() =>
        {
          if (query.length === 0) onOpenChange(false)
        }}
        onKeyDown={(event) =>
        {
          if (event.key === 'Escape')
          {
            event.preventDefault()
            onChange('')
            onOpenChange(false)
          }
        }}
        placeholder="Search keybindings"
        aria-label="Search keybindings"
        className="h-6 w-44 rounded-md border border-input bg-background pl-7 pr-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24"
      />
    </div>
  )
}

type BooleanOperator = 'and' | 'or'

function flattenWhenChildren(
  node: KeybindingWhenNode,
  operator: BooleanOperator,
): KeybindingWhenNode[]
{
  if (node.type !== operator) return [node]
  return [...flattenWhenChildren(node.left, operator), ...flattenWhenChildren(node.right, operator)]
}

function buildWhenExpressionGroup(
  children: readonly KeybindingWhenNode[],
  operator: BooleanOperator,
): KeybindingWhenNode | undefined
{
  const first = children[0]
  if (!first) return undefined
  return children.slice(1).reduce<KeybindingWhenNode>(
    (left, right) => ({
      type: operator,
      left,
      right,
    }),
    first,
  )
}

function conditionParts(node: KeybindingWhenNode): { identifier: string; negated: boolean } | null
{
  if (node.type === 'identifier') return { identifier: node.name, negated: false }
  if (node.type === 'not' && node.node.type === 'identifier')
  {
    return { identifier: node.node.name, negated: true }
  }
  return null
}

function setConditionIdentifier(node: KeybindingWhenNode, identifier: string): KeybindingWhenNode
{
  const parts = conditionParts(node)
  if (!parts) return node
  const next: KeybindingWhenNode = { type: 'identifier', name: identifier }
  return parts.negated ? { type: 'not', node: next } : next
}

function setConditionNegated(node: KeybindingWhenNode, negated: boolean): KeybindingWhenNode
{
  const parts = conditionParts(node)
  if (!parts) return negated ? { type: 'not', node } : node
  const identifier: KeybindingWhenNode = { type: 'identifier', name: parts.identifier }
  return negated ? { type: 'not', node: identifier } : identifier
}

function defaultWhenCondition(): KeybindingWhenNode
{
  return { type: 'identifier', name: DEFAULT_WHEN_VARIABLE }
}

function defaultWhenGroup(operator: BooleanOperator = 'and'): KeybindingWhenNode
{
  return {
    type: operator,
    left: defaultWhenCondition(),
    right: { type: 'not', node: defaultWhenCondition() },
  }
}

export function UnknownWhenVariableWarning({
  identifiers,
  focusable = true,
}: {
  identifiers: ReadonlyArray<string>
  focusable?: boolean
})
{
  if (identifiers.length === 0) return null
  const label =
    identifiers.length === 1
      ? `Unknown condition: ${identifiers[0]}`
      : `Unknown conditions: ${identifiers.join(', ')}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={focusable ? 0 : undefined}
            aria-label={label}
            className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        456code does not recognize this condition yet. It can still be saved, but it may not match
        unless the runtime provides it.
      </TooltipPopup>
    </Tooltip>
  )
}

export function KeybindingConflictWarning({ labels }: { labels: ReadonlyArray<string> })
{
  if (labels.length === 0) return null
  const description =
    labels.length === 1
      ? `Conflicts with ${labels[0]}.`
      : `Conflicts with ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', and more' : ''}.`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={description}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-[3px] focus-visible:ring-warning/25"
          >
            <TriangleAlertIcon className="size-3.5" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-relaxed">
        {description} The most recent matching binding wins when both conditions can apply.
      </TooltipPopup>
    </Tooltip>
  )
}

export function WhenVariableSelect({
  value,
  variables,
  unknownIdentifiers,
  onChange,
}: {
  value: string
  variables: ReadonlyArray<WhenVariableOption>
  unknownIdentifiers?: ReadonlyArray<string>
  onChange: (value: string) => void
})
{
  const selected = variables.find((option) => option === value)
  const options =
    selected || variables.some((option) => option === value) ? variables : [value, ...variables]

  return (
    <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
      <SelectTrigger
        size="xs"
        className="h-7 min-h-7 min-w-0 flex-1 rounded-md font-mono text-xs sm:h-7"
      >
        <SelectValue placeholder="Condition" className="leading-7" />
        {unknownIdentifiers && unknownIdentifiers.length > 0 ? (
          <UnknownWhenVariableWarning identifiers={unknownIdentifiers} focusable={false} />
        ) : null}
      </SelectTrigger>
      <SelectContent
        alignItemWithTrigger={false}
        matchTriggerWidth={false}
        popupClassName="w-fit"
        className="max-h-72 w-fit min-w-44"
      >
        {options.map((option) => (
          <SelectItem
            key={option}
            value={option}
            className="min-h-7 w-full py-1 font-mono text-[12px]"
          >
            <span className="truncate">{option}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function WhenExpressionNodeEditor({
  node,
  variables,
  depth = 0,
  onChange,
  onRemove,
}: {
  node: KeybindingWhenNode
  variables: ReadonlyArray<WhenVariableOption>
  depth?: number
  onChange: (node: KeybindingWhenNode) => void
  onRemove?: () => void
})
{
  const condition = conditionParts(node)

  if (condition)
  {
    const unknownIdentifiers = isKnownWhenVariable(condition.identifier)
      ? []
      : [condition.identifier]

    return (
      <div className="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-2">
        <Toggle
          pressed={condition.negated}
          onPressedChange={(pressed) => onChange(setConditionNegated(node, pressed))}
          aria-label={`Negate ${condition.identifier}`}
          variant="outline"
          size="xs"
          className="h-7 min-w-10 px-2 text-[11px] sm:h-7"
        >
          Not
        </Toggle>
        <WhenVariableSelect
          value={condition.identifier}
          variables={variables}
          unknownIdentifiers={unknownIdentifiers}
          onChange={(value) => onChange(setConditionIdentifier(node, value))}
        />
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 sm:size-7"
            aria-label="Remove condition"
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
    )
  }

  if (node.type === 'not')
  {
    return (
      <div
        className={cn(
          'space-y-2 rounded-lg border border-border/70 bg-muted/20 p-2',
          depth > 0 && 'border-border/50 bg-background/50',
        )}
      >
        <div className="flex items-center gap-2">
          <Toggle
            pressed
            onPressedChange={(pressed) => onChange(pressed ? node : node.node)}
            aria-label="Negate group"
            variant="outline"
            size="xs"
            className="h-7 min-w-10 px-2 text-[11px] sm:h-7"
          >
            Not
          </Toggle>
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto size-7 sm:size-7"
              aria-label="Remove negated group"
              onClick={onRemove}
            >
              <MinusIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="relative pl-4">
          <span className="absolute top-0 bottom-0 left-1.5 w-px bg-border/70" aria-hidden />
          <span className="absolute top-4 left-1.5 h-px w-2.5 bg-border/70" aria-hidden />
          <WhenExpressionNodeEditor
            node={node.node}
            variables={variables}
            depth={depth + 1}
            onChange={(next) => onChange({ type: 'not', node: next })}
          />
        </div>
      </div>
    )
  }

  const operator: BooleanOperator = node.type === 'or' ? 'or' : 'and'
  const children = flattenWhenChildren(node, operator)
  const childKeyCounts = new Map<string, number>()
  const childEntries = children.map((child) =>
  {
    const baseKey = `${child.type}-${whenAstToExpression(child)}`
    const count = childKeyCounts.get(baseKey) ?? 0
    childKeyCounts.set(baseKey, count + 1)
    return { child, key: count === 0 ? baseKey : `${baseKey}-${count}` }
  })

  const updateChild = (target: KeybindingWhenNode, next: KeybindingWhenNode) =>
  {
    let didUpdate = false
    const nextChildren = children.map((child) =>
    {
      if (!didUpdate && child === target)
      {
        didUpdate = true
        return next
      }
      return child
    })
    const nextNode = buildWhenExpressionGroup(nextChildren, operator)
    if (nextNode) onChange(nextNode)
  }

  const removeChild = (target: KeybindingWhenNode) =>
  {
    let didRemove = false
    const nextChildren = children.filter((child) =>
    {
      if (!didRemove && child === target)
      {
        didRemove = true
        return false
      }
      return true
    })
    const nextNode = buildWhenExpressionGroup(nextChildren, operator)
    if (nextNode)
    {
      onChange(nextNode)
    }
    else
    {
      onChange(defaultWhenCondition())
    }
  }

  const setOperator = (nextOperator: BooleanOperator) =>
  {
    if (nextOperator === operator) return
    const nextNode = buildWhenExpressionGroup(children, nextOperator)
    if (nextNode) onChange(nextNode)
  }

  const addCondition = () =>
  {
    const nextNode = buildWhenExpressionGroup([...children, defaultWhenCondition()], operator)
    if (nextNode) onChange(nextNode)
  }

  const addGroup = () =>
  {
    const nestedOperator: BooleanOperator = operator === 'and' ? 'or' : 'and'
    const group: KeybindingWhenNode = {
      type: nestedOperator,
      left: defaultWhenCondition(),
      right: { type: 'not', node: defaultWhenCondition() },
    }
    const nextNode = buildWhenExpressionGroup([...children, group], operator)
    if (nextNode) onChange(nextNode)
  }

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border border-border/60 bg-muted/10 p-2',
        depth > 0 && 'border-border/70 bg-background/55',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select value={operator} onValueChange={(value) => setOperator(value as BooleanOperator)}>
          <SelectTrigger size="xs" className="h-7 min-h-7 w-24 rounded-md text-xs sm:h-7">
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            alignItemWithTrigger={false}
            matchTriggerWidth={false}
            popupClassName="w-fit"
            className="w-fit min-w-24"
          >
            <SelectItem value="and" className="min-h-7 py-1 font-mono text-[12px]">
              and
            </SelectItem>
            <SelectItem value="or" className="min-h-7 py-1 font-mono text-[12px]">
              or
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="h-7 sm:h-7"
          onClick={addCondition}
        >
          <PlusIcon className="size-3.5" />
          Condition
        </Button>
        <Button type="button" variant="outline" size="xs" className="h-7 sm:h-7" onClick={addGroup}>
          <PlusIcon className="size-3.5" />
          Group
        </Button>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto size-7 sm:size-7"
            aria-label="Remove group"
            onClick={onRemove}
          >
            <MinusIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="space-y-2">
        {childEntries.map(({ child, key }) => (
          <div key={key} className="relative pl-4">
            <span
              className={cn(
                'absolute top-0 bottom-0 left-1.5 w-px',
                depth === 0 ? 'bg-border' : 'bg-border/70',
              )}
              aria-hidden
            />
            <span
              className={cn(
                'absolute top-4 left-1.5 h-px w-2.5',
                depth === 0 ? 'bg-border' : 'bg-border/70',
              )}
              aria-hidden
            />
            <WhenExpressionNodeEditor
              node={child}
              variables={variables}
              depth={depth + 1}
              onChange={(next) => updateChild(child, next)}
              onRemove={() => removeChild(child)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

export function WhenExpressionBuilder({
  value,
  variables,
  onChange,
  onValidityChange,
}: {
  value: KeybindingWhenNode | undefined
  variables: ReadonlyArray<WhenVariableOption>
  onChange: (value: KeybindingWhenNode | undefined) => void
  onValidityChange?: (valid: boolean) => void
})
{
  const expression = whenAstToExpression(value)
  const [expressionDraft, setExpressionDraft] = useState(expression)
  const parseResult = useMemo(() => parseWhenExpressionDraft(expressionDraft), [expressionDraft])
  const parseError = parseResult.ok ? null : parseResult.message
  const unknownIdentifiers = parseResult.ok ? unknownWhenVariables(parseResult.value) : []

  const updateExpressionDraft = (nextExpression: string) =>
  {
    setExpressionDraft(nextExpression)
    const nextResult = parseWhenExpressionDraft(nextExpression)
    onValidityChange?.(nextResult.ok)
    if (nextResult.ok)
    {
      onChange(nextResult.value)
    }
  }

  const updateExpressionValue = (nextValue: KeybindingWhenNode | undefined) =>
  {
    setExpressionDraft(whenAstToExpression(nextValue))
    onValidityChange?.(true)
    onChange(nextValue)
  }

  const addRootCondition = () =>
  {
    if (!value)
    {
      updateExpressionValue(defaultWhenCondition())
      return
    }
    updateExpressionValue({ type: 'and', left: value, right: defaultWhenCondition() })
  }

  const addRootGroup = () =>
  {
    const group = defaultWhenGroup('or')
    if (!value)
    {
      updateExpressionValue(group)
      return
    }
    updateExpressionValue({ type: 'and', left: value, right: group })
  }

  return (
    <div className="w-[min(34rem,calc(100vw-2rem))] space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">When</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 sm:h-7"
            onClick={addRootCondition}
          >
            <PlusIcon className="size-3.5" />
            Condition
          </Button>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 sm:h-7"
            onClick={addRootGroup}
          >
            <PlusIcon className="size-3.5" />
            Group
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="relative">
          <Input
            value={expressionDraft}
            onChange={(event) => updateExpressionDraft(event.currentTarget.value)}
            placeholder="Always"
            aria-invalid={Boolean(parseError)}
            aria-label="When expression"
            className={cn(
              'h-7 rounded-md font-mono text-[12px] leading-7 sm:h-7 sm:leading-7',
              unknownIdentifiers.length > 0 && 'pr-9',
              parseError && 'border-destructive/70 focus-visible:border-destructive',
            )}
          />
          {unknownIdentifiers.length > 0 ? (
            <span className="absolute inset-y-0 right-2 flex items-center">
              <UnknownWhenVariableWarning identifiers={unknownIdentifiers} />
            </span>
          ) : null}
        </div>
        {parseError ? (
          <div className="flex items-center gap-1.5 text-[11px] text-destructive">
            <CircleXIcon className="size-3.5" />
            {parseError}
          </div>
        ) : null}
      </div>

      <div className="relative">
        {value ? (
          <WhenExpressionNodeEditor
            node={value}
            variables={variables}
            onChange={updateExpressionValue}
            onRemove={() => updateExpressionValue(undefined)}
          />
        ) : (
          <div className="rounded-md border border-dashed border-border/80 bg-muted/15 p-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="xs" className="h-7 sm:h-7" onClick={addRootCondition}>
                <PlusIcon className="size-3.5" />
                Condition
              </Button>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-7 sm:h-7"
                onClick={addRootGroup}
              >
                <PlusIcon className="size-3.5" />
                Group
              </Button>
            </div>
          </div>
        )}
        {parseError ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border border-destructive/30 bg-background/75 p-4 text-center text-xs text-destructive backdrop-blur-[1px]">
            Fix the expression above to continue editing visually.
          </div>
        ) : null}
      </div>
    </div>
  )
}
