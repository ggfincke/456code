<!-- docs/user/local-pairing-cli.md -->
<!-- explain verified local pairing discovery and display URL overrides -->

# Pair with a running local server

Run `456code pair` on the server's machine to print a fresh one-time pairing URL, QR code, and
expiry. The server must already be running and listening on loopback or a wildcard interface.
The command does not start a server, configure Tailscale, or open a second auth database.

```bash
456code pair --base-dir /path/to/server-data
456code pair --base-dir /path/to/server-data --base-url https://existing-web-origin.example
```

`--base-dir` selects only that home. Otherwise the command checks the enclosing Git checkout's
`.t3`, then `.456code`, then `T3CODE_HOME` (or the usual `~/.456code` default). A local candidate
is selected only when it has runtime metadata. Within each home, `userdata` precedes `dev`.
Once a runtime file is found, stale, malformed, or mismatched metadata stops pairing; the command
never silently falls back to another server.

The runtime PID, local storage lease, process birth where available, canonical home, and saved
environment ID are checked before issuing a credential. The responding server's public descriptor
must match that environment. All issuance goes to a literal loopback address with redirects disabled;
the storage-owner capability never goes to a web URL or an external host. Only standard-client
scopes are issued; administrative, recovery, and relay-write scopes are not available through `pair`.

For development servers, newly written runtime metadata records the web URL. `--base-url` overrides
only the URL displayed in the QR code; it never changes the credential destination. Use the current
web origin explicitly for an older dev runtime that does not record it. A loopback display URL works
only on the same machine; the override must already route to this server for another device to use it.

`--label` names the credential. Expiry is controlled by the existing server pairing policy; `pair`
does not expose a custom TTL flag or change `auth pairing create` defaults. Treat the printed URL
and QR as secrets: the token is short-lived and single-use.
