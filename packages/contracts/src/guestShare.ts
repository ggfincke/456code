import * as Schema from "effect/Schema";

import { ChatAttachment } from "./chatAttachment.ts";
import { GuestMessageId, GuestShareId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Guest sharing is removed. Stored thread events and messages can still carry a guest share or a
 * guest's attribution, so these schemas stay to decode them.
 */
export const GUEST_MESSAGE_MAX_LENGTH = 4_000;
export const GUEST_NAME_MAX_LENGTH = 40;

export const ThreadGuestMessageStatus = Schema.Literals(["pending", "sent", "dismissed"]);
export type ThreadGuestMessageStatus = typeof ThreadGuestMessageStatus.Type;

export const ThreadGuestMessage = Schema.Struct({
  id: GuestMessageId,
  text: Schema.String,
  status: ThreadGuestMessageStatus,
  submittedAt: IsoDateTime,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
});
export type ThreadGuestMessage = typeof ThreadGuestMessage.Type;

export const ThreadGuestShare = Schema.Struct({
  id: GuestShareId,
  host: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  guestName: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ThreadGuestMessage),
});
export type ThreadGuestShare = typeof ThreadGuestShare.Type;
