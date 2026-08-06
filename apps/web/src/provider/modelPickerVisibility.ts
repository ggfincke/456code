// apps/web/src/provider/modelPickerVisibility.ts
// determine whether model picker open

const MODEL_PICKER_CONTENT_SELECTOR = '[data-model-picker-content]'

// model-picker visibility is already represented by the mounted popover.
// shortcut arbitration reads that source directly instead of mirroring it in
// a second React or external store.
export function isModelPickerOpen(): boolean
{
  return (
    typeof document !== 'undefined' &&
    document.querySelector(MODEL_PICKER_CONTENT_SELECTOR) !== null
  )
}
