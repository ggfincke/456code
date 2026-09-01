// apps/mobile/src/components/ComposerAttachmentStrip.tsx
// render composer attachment strip

import { SymbolView } from '../components/AppSymbol'
import type { EnvironmentId } from '@t3tools/contracts'
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native'

import type { DraftComposerImageAttachment } from '../lib/composerImages'
import {
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadState,
} from '../state/composer-attachment-uploads'

export interface ComposerAttachmentStripProps
{
  // attachment images to display.
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>
  readonly environmentId?: EnvironmentId
  // called when the user taps the remove button on an image.
  readonly onRemove: (imageId: string) => void
  // called when the user taps on an image thumbnail to preview it.
  readonly onPressImage?: (previewUri: string) => void
  // image thumbnail size in points.  Defaults to 72.
  readonly imageSize?: number
  // border radius of each image thumbnail.  Defaults to 16.
  readonly imageBorderRadius?: number
  // whether the remove button should sit in its own gutter instead of overlapping the image.
  readonly removeButtonPlacement?: 'overlay' | 'gutter'
}

function ComposerAttachmentItem(props: {
  readonly image: DraftComposerImageAttachment
  readonly environmentId?: EnvironmentId
  readonly size: number
  readonly radius: number
  readonly removeButtonPlacement: 'overlay' | 'gutter'
  readonly removeButtonGutter: number
  readonly onRemove: (imageId: string) => void
  readonly onPressImage?: (previewUri: string) => void
})
{
  const upload = useComposerAttachmentUploadState(props.environmentId, props.image.id)
  const failed = upload?.status === 'failed'

  return (
    <View
      className="relative"
      style={{
        paddingTop: props.removeButtonGutter,
        paddingRight: props.removeButtonGutter,
      }}
    >
      <Pressable
        onPress={
          failed && props.environmentId
            ? () => retryComposerAttachmentUpload(props.environmentId!, props.image.id)
            : props.onPressImage
              ? () => props.onPressImage!(props.image.previewUri)
              : undefined
        }
      >
        <Image
          source={{ uri: props.image.previewUri }}
          className="bg-subtle"
          style={{
            width: props.size,
            height: props.size,
            borderRadius: props.radius,
            opacity: upload?.status === 'uploading' ? 0.6 : 1,
          }}
          resizeMode="cover"
        />
        {upload?.status === 'uploading' ? (
          <View className="absolute inset-0 items-center justify-center">
            <ActivityIndicator color="#ffffff" />
          </View>
        ) : failed ? (
          <View className="absolute inset-0 items-center justify-center rounded-2xl bg-black/55">
            <SymbolView
              name="arrow.clockwise"
              size={18}
              tintColor="#ffffff"
              type="monochrome"
              weight="semibold"
            />
          </View>
        ) : null}
      </Pressable>
      <Pressable
        className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
        style={{
          top: props.removeButtonPlacement === 'gutter' ? 0 : 4,
          right: props.removeButtonPlacement === 'gutter' ? 0 : 4,
        }}
        hitSlop={6}
        onPress={() => props.onRemove(props.image.id)}
      >
        <SymbolView name="xmark" size={9} tintColor="#ffffff" type="monochrome" weight="bold" />
      </Pressable>
    </View>
  )
}

// a horizontally-scrollable strip of image attachment thumbnails with remove
// buttons.  Used by both the thread composer and the new-task draft screen.
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps)
{
  const size = props.imageSize ?? 72
  const radius = props.imageBorderRadius ?? 16
  const removeButtonPlacement = props.removeButtonPlacement ?? 'overlay'
  const removeButtonGutter = removeButtonPlacement === 'gutter' ? 10 : 0

  if (props.attachments.length === 0)
  {
    return null
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((image) => (
          <ComposerAttachmentItem
            key={image.id}
            image={image}
            environmentId={props.environmentId}
            size={size}
            radius={radius}
            removeButtonPlacement={removeButtonPlacement}
            removeButtonGutter={removeButtonGutter}
            onRemove={props.onRemove}
            onPressImage={props.onPressImage}
          />
        ))}
      </View>
    </ScrollView>
  )
}
