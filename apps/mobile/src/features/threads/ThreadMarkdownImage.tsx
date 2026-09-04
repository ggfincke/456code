// apps/mobile/src/features/threads/ThreadMarkdownImage.tsx
// render authenticated markdown images in thread and file surfaces

import type { AssetResource, EnvironmentId } from '@t3tools/contracts'
import { useState } from 'react'
import { ActivityIndicator, Image, Pressable, View } from 'react-native'

import { AppText as Text } from '../../components/AppText'
import { useAssetUrl } from '../../state/assets'

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null
  readonly unavailable: boolean
  readonly alt: string | null
  readonly onPressImage: (uri: string) => void
  readonly onRetry?: (() => void) | undefined
})
{
  const [failedUri, setFailedUri] = useState<string | null>(null)
  const unavailable = props.unavailable || (props.uri !== null && failedUri === props.uri)
  return (
    <View className="w-full gap-1.5">
      {props.uri !== null && !unavailable ? (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={props.alt ?? 'Markdown image'}
          onPress={() => props.onPressImage(props.uri!)}
        >
          <Image
            source={{ uri: props.uri }}
            resizeMode="contain"
            className="aspect-video w-full rounded-[10px] bg-md-code-bg"
            onError={() => setFailedUri(props.uri)}
          />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole={props.onRetry ? 'button' : 'image'}
          accessibilityLabel={
            unavailable && props.onRetry ? 'Retry markdown image' : (props.alt ?? 'Markdown image')
          }
          disabled={!props.onRetry}
          onPress={() =>
            {
            setFailedUri(null)
            props.onRetry?.()
          }}
          className="aspect-video w-full items-center justify-center rounded-[10px] bg-md-code-bg"
        >
          {unavailable ? (
            <Text className="text-xs text-foreground-muted">
              {props.onRetry ? 'Tap to retry' : 'Image unavailable'}
            </Text>
          ) : (
            <ActivityIndicator />
          )}
        </Pressable>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  )
}

export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId
  readonly resource: AssetResource
  readonly alt: string | null
  readonly srcFragment?: string | undefined
  readonly onPressImage: (uri: string) => void
})
{
  const assetUrl = useAssetUrl(props.environmentId, props.resource)

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === 'Success' ? assetUrl.url + (props.srcFragment ?? '') : null}
      unavailable={assetUrl._tag === 'Failure'}
      alt={props.alt}
      onPressImage={props.onPressImage}
      onRetry={'retry' in assetUrl ? assetUrl.retry : undefined}
    />
  )
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null })
{
  return (
    <ThreadMarkdownImageView
      uri={null}
      unavailable
      alt={props.alt}
      onPressImage={() => undefined}
    />
  )
}
