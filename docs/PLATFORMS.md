# Platform support

Support levels here are claims about **testing**, not promises about behaviour.

| Level | Means |
|---|---|
| **supported** | Runs here every day, on real machines, as the maintainers' own fleet. |
| **experimental** | Implemented and reviewed. Not run by the maintainers. May be wrong. |
| **unsupported** | No honest implementation exists. The seam refuses by name. |

| Seam | Linux | macOS | Windows |
|---|---|---|---|
| Sync, gossip, pairing, console, MCP | supported | experimental | experimental |
| Service manager | `systemctl --user` — supported | `launchctl kickstart` — experimental | `Restart-Service` — experimental |
| Desktop notification | gdbus (freedesktop, GTK fallback) — supported | `osascript` — experimental | WinRT toast — experimental |
| Credential store | `systemd-creds` — supported | login Keychain — experimental | DPAPI CurrentUser — experimental |
| Store privacy probe | `/proc/self/mountinfo` — supported | write-then-stat — experimental | write-then-stat — experimental |
| Privilege elevation (`sudo`) | supported | expected to work, untested | **unsupported** |

## The rule that makes "experimental" safe

**Every seam proves itself by doing the thing, never by asking whether it can.**

A capability query has already produced a confidently wrong answer on this project's own hardware:
TPM sealing was reported as available and was in fact refused for an unprivileged user. A live
round trip — seal a throwaway value, unseal it, compare — catches that on the first run. The query
never does.

So the credential store is not trusted because the platform claims to have one. It is trusted
because a real value went in and came back out unchanged, on this machine, as this user, just now.

The second rule follows from the first: **a seam that cannot work refuses by name.** It says which
platform and which capability, rather than throwing something generic at the first real call — and
never, ever appears to succeed.

## Per-platform notes

### Linux — supported

**Installing.** One command on Debian or Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/SUKARDADDY/sukarfleet/v0.1.0/install/get.sh | sh
```

It clones the tag into `~/.local/share/sukarfleet/app` and runs `install/quickstart.sh`, which
installs Bun if it is missing, writes the config and the systemd user unit, starts the daemon, and
opens the console: a native tray window on a desktop, the printed `http://127.0.0.1:7710/ui/` on a
headless box or wherever the tray's two shared libraries are absent. Then the console prints **one**
command that needs root, and it is the only password moment: it adopts the staged mesh secret,
installs a SHA256-pinned EasyTier, starts the mesh transport, and opens the listener ports if a
firewall is already running. Removal is `./install/uninstall.sh` plus `sudo ./install/uninstall.sh
--elevated`.

Debian and Ubuntu family only, read from `/etc/os-release`. Every other distro is refused by name
rather than attempted: the daemon has no distro dependency, but the installer's dependency handling
does. `docs/INSTALL-FLOW.md` section 9 is the manual route, and
`SUKARFLEET_SKIP_DISTRO_CHECK=1` is how someone takes it.

The reference platform. `systemd-creds --user` seals the admin credential; TPM scope is attempted
first and normally loses, because system-scope sealing needs `/var/lib/systemd/credential.secret`
(0400 root:root) and this daemon has neither root nor an interactive polkit prompt.

The store-privacy probe reads the mount table, because a `0700` reading from `stat()` means nothing
on a filesystem that ignores `chmod`. fuseblk, NTFS, exFAT, vfat, CIFS and friends are rejected as
credential-store locations for exactly that reason.

### macOS — experimental

Everything except privilege elevation is implemented and expected to work. There is no `get.sh` path: `install/quickstart.sh` is systemd-specific, so a Mac is a manual install. **No maintainer owns a
Mac**, so "experimental" here genuinely means untried until a stranger tries it.

Two specific unknowns:

- **Notifications may silently not appear.** macOS drops notifications from unsigned background
  processes in some configurations; the `osascript` call succeeds and nothing is shown. This cannot
  be detected, and is one reason notification failure is treated as cosmetic and never blocks a sync.
- **Keychain access from a launchd agent** depends on the login keychain being unlocked in the
  daemon's session. If it is not, the credential self-test fails — which is the correct outcome, and
  the admin lane refuses rather than storing something it cannot claim is private.

### Windows — experimental, with one honest gap

Sync, gossip, pairing, the console and the MCP surface are implemented and should work.

**The admin lane cannot elevate on Windows.** There is no `sudo`. The lane's entire design is
"pipe one password line to a privilege-elevation tool that reads stdin", and Windows has no such
tool. This is not a missing implementation that someone could contribute in an afternoon; it is a
different mechanism (UAC, a service running as SYSTEM, or a scheduled task) with a different threat
model, and pretending otherwise would produce exactly the confidently wrong answer this project
refuses to give.

So: the seam says **unsupported** out loud, and sync is unaffected. Run the sync half on Windows and
drive admin from a Linux machine.

The installer is [`install/windows/`](../install/windows/README.md): double-click
`Add-To-Fleet.cmd`. It writes `admin.enabled: false` rather than leaving a lane switched on that
refuses at the first real call.

Also note the store-privacy probe will typically report that mode is **not** enforced on NTFS,
because NTFS carries ACLs rather than POSIX mode bits. That is an honest answer, and the admin lane
refuses on it rather than storing a credential whose privacy it cannot demonstrate.

### Anything else — unsupported

Every seam refuses by name. Sync may well work, since it is plain git over HTTP.

## If you are porting to a new platform

1. Add a backend in [`src/platform.ts`](../src/platform.ts). Do not add a capability query.
2. Make the credential backend a **stdin → stdout filter**. The seam supplies argv only and must
   never see a plaintext password — that invariant lives in `secrets.ts` and stays there.
3. Label it `experimental` until you have run it on real hardware for real work.
4. Make failure honest. A refusal naming the platform beats a stack trace, and both beat a silent
   success.
