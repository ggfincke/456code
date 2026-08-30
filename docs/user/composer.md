# Message composer

The web and desktop composer accepts GIF, HEIC, HEIF, JPEG, PNG, and WebP image attachments. HEIC
and HEIF photos are converted to JPEG when you drag them into the composer or paste them into a
message. Other supported images keep their original format when they already fit the attachment
size limit.

On an environment that supports file uploads, use **Attach files**, drag files into the web or
desktop composer, or paste a file. PDFs, ZIPs, and other files may be up to 50 MiB each (or the
environment's advertised lower limit). Images retain their existing 10 MiB limit. A turn may
contain eight attachments total, mixing images and files. Upload progress appears in the
composer; retry or remove a failed upload before sending. When the clipboard also contains text,
pasting non-image files prefers that text.

Uploaded files in drafts and provider-scoped stashes retain their server upload ID and environment,
not a browser copy of the bytes. Reloading verifies the uploaded copy. If an unfinished upload lost
its local bytes, or the server reports that its upload expired, reattach the original file. A
temporary connection failure keeps the saved ID for retry. Switching environments re-verifies the
matching upload or uploads local bytes to the new environment; a file with no local bytes must be
restored in its original environment or reattached. A stash containing files stays intact when
restored into another environment or a composer without enough attachment slots.

Stashing waits for file uploads and saves the stash before clearing the composer. Discarding a
file, stash entry, thread, or project releases its pending uploads. Sent files appear as download
rows, not image previews. Mobile continues to accept images; it safely skips other attachment
kinds when rendering an existing mixed-attachment message.

On mobile, existing threads and new-task drafts share command autocomplete. Type `/` for built-in
commands, provider commands, and enabled skills; `$` searches skills; `@` searches files and folders
in the selected project. Plan and orchestration commands follow the selected provider's capabilities.
Codex `/feedback` is available only after the task has a thread.

The mobile model picker shows an OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name when provided. In an existing thread or a new-task
draft, type `/model` and search by that provider name to narrow the list without changing
which OpenCode instance runs the model.
