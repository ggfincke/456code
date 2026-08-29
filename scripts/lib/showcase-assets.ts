// scripts/lib/showcase-assets.ts
// validates and normalizes mobile showcase store screenshot assets

// @effect-diagnostics nodeBuiltinImport:off - Host-side showcase assets use Node path APIs directly.

import { PNG } from 'pngjs'
import * as NodePath from 'node:path'

import type { ShowcaseStoreAssetSpec } from '../mobile-showcase.config.ts'
import type { ShowcaseCapture } from './showcase-plan.ts'

export interface PngMetadata
{
  readonly width: number
  readonly height: number
  readonly bitDepth: number
  readonly colorType: number
  readonly hasAlpha: boolean
}

export function readPngMetadata(bytes: Uint8Array): PngMetadata
{
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.byteLength < 26 || !pngSignature.every((value, index) => bytes[index] === value))
  {
    throw new Error('Captured file is not a valid PNG.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const colorType = view.getUint8(25)
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: view.getUint8(24),
    colorType,
    hasAlpha: colorType === 4 || colorType === 6,
  }
}

export function readPngDimensions(bytes: Uint8Array): {
  readonly width: number
  readonly height: number
}
{
  const { width, height } = readPngMetadata(bytes)
  return { width, height }
}

export function normalizeStorePng(bytes: Uint8Array): Buffer
{
  const png = PNG.sync.read(Buffer.from(bytes))
  return PNG.sync.write(png, {
    bitDepth: 8,
    colorType: 2,
    inputColorType: 6,
    inputHasAlpha: true,
  })
}

export function validateStoreAsset(
  spec: ShowcaseStoreAssetSpec,
  bytes: Uint8Array,
  label = 'Screenshot',
): PngMetadata
{
  const metadata = readPngMetadata(bytes)
  if (metadata.width !== spec.width || metadata.height !== spec.height)
  {
    throw new Error(
      `${label} is ${metadata.width}×${metadata.height}; ${spec.store} requires ${spec.width}×${spec.height}.`,
    )
  }
  if (metadata.bitDepth !== 8 || metadata.colorType !== 2 || metadata.hasAlpha)
  {
    throw new Error(
      `${label} must be an 8-bit, 24-bit RGB PNG without alpha (found bit depth ${metadata.bitDepth}, color type ${metadata.colorType}).`,
    )
  }
  return metadata
}

export function validateStoreAssetCount(
  spec: ShowcaseStoreAssetSpec,
  count: number,
  requireMinimum: boolean,
): void
{
  if (count > spec.maximumUploadCount)
  {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} allows at most ${spec.maximumUploadCount}.`,
    )
  }
  if (requireMinimum && count < spec.minimumUploadCount)
  {
    throw new Error(
      `${spec.directory} contains ${count} screenshots; ${spec.store} requires at least ${spec.minimumUploadCount}.`,
    )
  }
}

export function showcaseCaptureDirectory(
  outputDirectory: string,
  capture: Pick<ShowcaseCapture, 'device' | 'appearance'>,
): string
{
  return NodePath.join(outputDirectory, capture.device.storeAsset.directory, capture.appearance)
}
