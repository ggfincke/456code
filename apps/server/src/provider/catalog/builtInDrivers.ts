// apps/server/src/provider/catalog/builtInDrivers.ts
// register the server's built-in provider drivers

//
// every driver that the server knows how to instantiate from settings is
// listed here. The `ProviderInstanceRegistry` iterates this array when
// resolving `providerInstances` entries; anything not in the array surfaces
// as an `"unavailable"` shadow snapshot at runtime (see
// `buildUnavailableProviderSnapshot`).
//
// adding a new first-party driver means:
//   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
//   2. add it to this array,
//   3. ensure the runtime layer satisfies its declared `R`.
//
// the aggregated `BuiltInDriversEnv` type is the union of every driver's
// env requirement — the registry layer's `R` is this type, and the runtime
// layer (ChildProcessSpawner, FileSystem, Path, ServerConfig,
// OpenCodeRuntime, …) must satisfy it.
//
// @module provider/builtInDrivers
import { ClaudeDriver, type ClaudeDriverEnv } from '../Drivers/ClaudeDriver.ts'
import { AntigravityDriver, type AntigravityDriverEnv } from '../Drivers/AntigravityDriver.ts'
import { CodexDriver, type CodexDriverEnv } from '../Drivers/CodexDriver.ts'
import { CoralDriver, type CoralDriverEnv } from '../Drivers/CoralDriver.ts'
import { CursorDriver, type CursorDriverEnv } from '../Drivers/CursorDriver.ts'
import { GeminiDriver, type GeminiDriverEnv } from '../Drivers/GeminiDriver.ts'
import { GrokDriver, type GrokDriverEnv } from '../Drivers/GrokDriver.ts'
import { OpenCodeDriver, type OpenCodeDriverEnv } from '../Drivers/OpenCodeDriver.ts'
import type { AnyProviderDriver } from './ProviderDriver.ts'

// union of infrastructure services required to construct any built-in
// driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
// layer must provide every service in this union.
export type BuiltInDriversEnv =
  | ClaudeDriverEnv
  | AntigravityDriverEnv
  | CodexDriverEnv
  | CoralDriverEnv
  | CursorDriverEnv
  | GeminiDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv

// ordered list of built-in drivers. Order matters only for tie-breaking in
// UI presentation — the registry itself is keyed by `driverKind`, so
// iteration order has no functional effect on instance lookup.
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  AntigravityDriver,
  ClaudeDriver,
  CoralDriver,
  CursorDriver,
  GeminiDriver,
  GrokDriver,
  OpenCodeDriver,
]
