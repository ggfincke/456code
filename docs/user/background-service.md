# Running 456code in the Background

On a Linux host, 456code can run as a background service for your user. It starts when the machine
boots and keeps running after you log out.

## Manage the Service

Install it with the latest 456code release:

```sh
npx 456code@latest service install
```

Check whether it is installed:

```sh
npx 456code@latest service status
```

Update or repair it:

```sh
npx 456code@latest service update
```

Stop it and remove it from startup:

```sh
npx 456code@latest service uninstall
```

Updating restarts 456code briefly. Let active agent work and terminal commands finish first.

The background service currently requires Linux with systemd.
