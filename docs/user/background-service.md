# Running 456code in the Background

On Linux and macOS, 456code can run as a background service for your user without keeping a
terminal open.

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

## Platform Support

Linux uses a systemd user unit at `~/.config/systemd/user/456code.service`. It starts when the
machine boots and keeps running after logout because install enables lingering.

macOS uses a launch agent at
`~/Library/LaunchAgents/com.t3tools.456code.service.plist`. It starts at login and stops at logout;
macOS has no user-service equivalent of Linux lingering. Installing over SSH requires a user to be
logged in to the Mac's GUI for the agent to start immediately. Protected folders may require Full
Disk Access for the Node executable recorded in the plist.

Windows is not supported yet.
