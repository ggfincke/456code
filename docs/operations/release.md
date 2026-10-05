# Local packaging and validation

> For maintainers. Using 456code? See [docs/user](../user/).

This fork retains local desktop and CLI packaging tools. CI runs code/build checks, manual Windows
compatibility tests, and advisory mobile fingerprints on standard GitHub runners. Automated
release publishing, deployment, hosted previews, store submission, and upstream administration
workflows have been removed.

## Build desktop artifacts

Follow the [development prerequisites](development.md#desktop-artifacts) for the target platform.
The artifact builder runs the required desktop/server/web builds and writes unsigned artifacts to
`release/` by default:
