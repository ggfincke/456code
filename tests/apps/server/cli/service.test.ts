import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "../../../../apps/server/src/cli/service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/456code.service",
  logPath: "/home/me/.456code/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "456code service",
      "  Status: installed · 456code@0.0.29",
      "  Unit: /home/me/.config/systemd/user/456code.service",
      "  Logs: /home/me/.456code/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx 456code@latest service update`.",
  );
});

it("explains service availability without systemd", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd",
  );
});
