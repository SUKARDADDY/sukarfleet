---
name: Bug report
about: Something behaves differently from what the docs say
title: ''
labels: ''
assignees: ''
---

**What happened, and what you expected instead.**

**Steps to reproduce.** The shortest sequence that produces it.

**Environment.**

- OS and version:
- sukarfleet version (`git describe --tags`, or the tag you installed):
- Bun version (`bun --version`):
- Installed how: `install/get.sh`, `install/windows/Add-To-Fleet.cmd`, or by hand

**Logs.** `journalctl --user -u sukarfleet -n 200` on Linux, or the console's own output.

Please scrub machine names, mesh addresses and hostnames before pasting. Replace them with
placeholders. The reserved documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
are what the fixtures in this repository use.
