// apps/mobile/src/state/attachments.ts
// bind attachment upload commands to mobile environment connections

import { createAttachmentEnvironmentAtoms } from '@t3tools/client-runtime/state/attachments'

import { connectionAtomRuntime } from '../connection/runtime'

export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime)
