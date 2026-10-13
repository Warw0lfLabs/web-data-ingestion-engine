import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { URL } from "node:url";
const profile = JSON.parse(
  readFileSync(new URL("../docker/chromium-seccomp.json", import.meta.url)),
);
const rules = profile.syscalls.filter(
  (rule) => rule.names.length === 1 && rule.names[0] === "chroot",
);
assert.equal(rules.length, 1);
assert.deepEqual(rules[0].includes, { caps: ["CAP_SYS_CHROOT"] });
// Chromium chroots inside its new user namespace. Retain zero outer capabilities;
// allow this syscall through seccomp, leaving kernel capability checks intact.
// All other production-profile restrictions remain byte-for-byte equivalent.
rules[0].includes = {};
process.stdout.write(JSON.stringify(profile));
