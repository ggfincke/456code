<!-- docs/user/environment-themes.md -->
<!-- publish local palettes and select environment-wide theme defaults -->

# Environment themes

Run `456code theme set` on the server's machine to select a built-in theme or publish a local
JSON file. Connected web and desktop clients receive published palettes and the environment's
default selection. Mobile does not opt into this feature.

```bash
456code theme set ocean --base-dir /path/to/server-data
456code theme set ./nightfall.json --base-dir /path/to/server-data
456code theme set ./export.json --id nightfall --base-dir /path/to/server-data
456code theme show --base-dir /path/to/server-data
456code theme clear --base-dir /path/to/server-data
```

`--base-dir` takes precedence over `T3CODE_HOME`, then the usual `~/.456code` default. Explicit
homes store themes in `userdata/themes` and settings in `userdata/settings.json`. Use the same
home as the running server. The CLI can also provision an environment before its server starts.

A minimal file contains a name, appearance, and both seed colors:

```json
{
  "version": 1,
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7"
}
```

The filename determines the published ID; an `id` inside the JSON is ignored. IDs are lowercase
letters, digits, and hyphens, start with a letter or digit, and are at most 48 characters.
`system`, `light`, `dark`, and `ocean` cannot be published IDs. The latter three remain valid
built-in selections. Use `theme clear` to stop imposing an environment default; clients keep
their current local choice rather than being reset.

Full palettes can supply a nonempty `colors` object instead of seeds. Optional `variants`
contains light and dark role overrides. Names are at most 48 characters, role names and values
at most 64, and seed colors use `#RGB` or `#RRGGBB`. Clients apply recognized color roles and
ignore unknown roles. Files are data, not stylesheets or executable code.

The server watches atomic replacements, edits, and removals without restarting. It examines at
most 32 eligible filenames in sorted order, accepts at most 192 KiB total, and rejects files over
32 KiB, symlinks, and non-regular files. Invalid files are skipped. A CLI publication excluded by
these same limits fails and rolls back instead of selecting an unavailable theme.

Theme selection preserves unrelated and unknown settings keys. Repeating `theme set` produces a
new selection generation so connected clients can reapply it. Malformed or unreadable settings
stop the command without overwriting them. Publication uses a uniquely owned staged file and
rolls back its own replacement if selecting the default fails. Concurrent external writers are
handled with bounded best-effort checks, not a cross-process transaction.
