// apps/web/src/components/settings/CustomModelMetadataEditor.tsx
// edits validated names and option descriptors for a configured custom model

import { useId, useState } from 'react'
import { ModelCapabilities, type CustomModelMetadataEntry } from '@t3tools/contracts'
import * as Schema from 'effect/Schema'

import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'

const decodeCapabilities = Schema.decodeUnknownSync(Schema.fromJsonString(ModelCapabilities))

export function CustomModelMetadataEditor({
  slug,
  metadata,
  onChange,
}: {
  readonly slug: string
  readonly metadata: CustomModelMetadataEntry | undefined
  readonly onChange: (metadata: CustomModelMetadataEntry | null) => void
})
{
  const id = useId()
  const [name, setName] = useState(metadata?.name ?? '')
  const [options, setOptions] = useState(
    metadata?.capabilities ? JSON.stringify(metadata.capabilities, null, 2) : '',
  )
  const [error, setError] = useState<string | null>(null)
  return (
    <details className="col-span-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer py-1 focus-visible:outline focus-visible:outline-ring">
        Customize {slug}
      </summary>
      <form
        className="space-y-2 rounded-md border border-border/60 p-3"
        onSubmit={(event) =>
        {
          event.preventDefault()
          try
          {
            const capabilities = options.trim() ? decodeCapabilities(options) : undefined
            onChange({
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(capabilities ? { capabilities } : {}),
            })
            setError(null)
          }
          catch
          {
            setError(
              'Enter valid capabilities JSON with an optionDescriptors array, or leave it empty to use provider defaults.',
            )
          }
        }}
      >
        <label htmlFor={`${id}-name`} className="block space-y-1">
          Display name
          <Input
            id={`${id}-name`}
            value={name}
            placeholder={slug}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label htmlFor={`${id}-options`} className="block space-y-1">
          Advanced model options (JSON)
          <Textarea
            id={`${id}-options`}
            value={options}
            onChange={(event) => setOptions(event.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={'{"optionDescriptors": []}'}
            aria-invalid={error !== null}
            aria-describedby={`${id}-error`}
          />
        </label>
        <p>
          Only option descriptors supported by the selected provider are useful. Blank fields
          restore the provider defaults; the model slug is unchanged.
        </p>
        <p id={`${id}-error`} role="status" className="text-destructive">
          {error}
        </p>
        <div className="flex gap-2">
          <Button type="submit" variant="outline" size="sm">
            Save metadata
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={metadata === undefined}
            onClick={() =>
            {
              onChange(null)
              setName('')
              setOptions('')
              setError(null)
            }}
          >
            Reset metadata
          </Button>
        </div>
      </form>
    </details>
  )
}
