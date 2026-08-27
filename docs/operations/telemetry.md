<!-- docs/operations/telemetry.md -->
<!-- describe telemetry environment controls and opt-out precedence -->

# Telemetry controls

Set `T3CODE_TELEMETRY_ENABLED=false` before starting the server to disable analytics delivery.
An explicitly blank or whitespace-only `T3CODE_TELEMETRY_ENABLED`, `T3CODE_POSTHOG_KEY`, or
`T3CODE_POSTHOG_HOST` also disables delivery. Blanking an endpoint or key never selects the shipped
PostHog project instead.

When all three variables are unset, telemetry retains its existing enabled default and shipped
PostHog endpoint and project key. A nonblank `T3CODE_TELEMETRY_ENABLED=true` enables delivery only
when neither endpoint nor key is blank. Nonblank values retain the installed config provider's
existing boolean/default parsing behavior.

The ambient Effect config provider owns all telemetry settings, including batch size, buffer size,
and WSL metadata. An injected provider never falls back to process environment values. The installed
Effect environment provider preserves explicit blanks; only the three opt-out variables receive
special blank handling, without changing global configuration behavior.
