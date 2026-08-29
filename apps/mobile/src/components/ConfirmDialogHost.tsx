// apps/mobile/src/components/ConfirmDialogHost.tsx
// render confirm dialog host

import { Alert } from 'react-native'

export type ConfirmDialogRequest = {
  readonly title: string
  readonly message?: string
  readonly cancelText?: string
  readonly confirmText: string
  readonly destructive?: boolean
  readonly onConfirm: () => void
  readonly onCancel?: () => void
}

// present confirmations through the native alert controller.
export function showConfirmDialog(request: ConfirmDialogRequest): void
{
  Alert.alert(request.title, request.message, [
    {
      text: request.cancelText ?? 'Cancel',
      style: 'cancel',
      onPress: request.onCancel,
    },
    {
      text: request.confirmText,
      style: request.destructive ? 'destructive' : 'default',
      onPress: request.onConfirm,
    },
  ])
}
