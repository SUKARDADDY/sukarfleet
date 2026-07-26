// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The platform boundary. Taking the admin lane along meant inheriting its Linux coupling, and
// these are the seams where "one implementation written inline" became "a choice".
//
// What these tests are really defending is the honesty rule: a platform with no working
// implementation must refuse by name, not fail obscurely at the first real call and not appear to
// succeed. An experimental backend that lies is worse than one that is absent.

import { describe, expect, test } from 'bun:test';
import {
  currentPlatform,
  notificationBackendFor,
  platformReport,
  serviceManagerFor,
} from '../src/platform';
import type { Runner } from '../src/platform';
import { osNotify } from '../src/notify';

function recorder(results: { code: number; stderr?: string }[] = [{ code: 0 }]): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const runner: Runner = async (argv) => {
    calls.push(argv);
    const r = results[Math.min(i++, results.length - 1)]!;
    return { code: r.code, stdout: '', stderr: r.stderr ?? '' };
  };
  return { runner, calls };
}

describe('service manager', () => {
  test('linux restarts through sudo -n systemctl, the narrow passwordless rule', async () => {
    const { runner, calls } = recorder();
    const res = await serviceManagerFor('linux').restart('mesh.service', runner);
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual(['sudo', '-n', 'systemctl', 'restart', 'mesh.service']);
  });

  test('macos uses launchctl kickstart -k in the per-user gui domain', async () => {
    const { runner, calls } = recorder();
    const res = await serviceManagerFor('macos').restart('org.example.mesh', runner);
    expect(res.ok).toBe(true);
    expect(calls[0]![0]).toBe('launchctl');
    expect(calls[0]![1]).toBe('kickstart');
    expect(calls[0]![2]).toBe('-k');
    expect(calls[0]![3]).toContain('org.example.mesh');
  });

  test('windows uses Restart-Service and escapes quotes in the service name', async () => {
    const { runner, calls } = recorder();
    await serviceManagerFor('windows').restart("odd'name", runner);
    const script = calls[0]!.join(' ');
    expect(script).toContain('Restart-Service');
    // A single quote must be doubled, or it terminates the PowerShell string.
    expect(script).toContain("odd''name");
  });

  test('a non-zero exit is reported as failure with the stderr detail', async () => {
    const { runner } = recorder([{ code: 1, stderr: 'Unit not found' }]);
    const res = await serviceManagerFor('linux').restart('missing.service', runner);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('Unit not found');
  });

  test('an unknown platform refuses BY NAME rather than throwing', async () => {
    const res = await serviceManagerFor('unknown').restart('mesh.service');
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('no service manager implementation');
    // And it says the consequence out loud: sync keeps working.
    expect(res.detail).toContain('sync is unaffected');
  });
});

describe('notification backend', () => {
  test('linux falls back to the GTK channel when the freedesktop one fails', async () => {
    const { runner, calls } = recorder([{ code: 1, stderr: 'not activatable' }, { code: 0 }]);
    const res = await notificationBackendFor('linux').notify('critical', 'title', 'body', runner);
    expect(res.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0]!.join(' ')).toContain('org.freedesktop.Notifications');
    expect(calls[1]!.join(' ')).toContain('org.gtk.Notifications');
  });

  test('linux reports failure when BOTH channels fail', async () => {
    const { runner } = recorder([{ code: 1, stderr: 'a' }, { code: 1, stderr: 'b' }]);
    const res = await notificationBackendFor('linux').notify('normal', 't', 'b', runner);
    expect(res.ok).toBe(false);
  });

  test('macos escapes double quotes so the AppleScript string cannot be broken out of', async () => {
    const { runner, calls } = recorder();
    await notificationBackendFor('macos').notify('normal', 'ti"tle', 'bo"dy', runner);
    const script = calls[0]![2]!;
    expect(script).toContain('\\"');
    expect(script).toContain('display notification');
  });

  test('an unknown platform refuses rather than throwing', async () => {
    const res = await notificationBackendFor('unknown').notify('low', 't', 'b');
    expect(res.ok).toBe(false);
  });
});

describe('a failed notification never reaches the caller', () => {
  // Notification failure is cosmetic. A sync is not. Nothing here may propagate.
  test('osNotify swallows a failing backend', async () => {
    await osNotify('critical', 'title', 'body', async () => ({ code: 1, stdout: '', stderr: 'no session bus' }));
  });

  test('osNotify swallows a THROWING runner', async () => {
    await osNotify('critical', 'title', 'body', async () => {
      throw new Error('dbus exploded');
    });
  });
});

describe('support levels are honest', () => {
  test('linux is the platform this runs on daily', () => {
    expect(serviceManagerFor('linux').support).toBe('supported');
    expect(notificationBackendFor('linux').support).toBe('supported');
  });

  test('macos and windows are implemented but labelled experimental', () => {
    for (const p of ['macos', 'windows'] as const) {
      expect(serviceManagerFor(p).support).toBe('experimental');
      expect(notificationBackendFor(p).support).toBe('experimental');
    }
  });

  test('an unknown platform is unsupported, not quietly experimental', () => {
    expect(serviceManagerFor('unknown').support).toBe('unsupported');
  });

  test('the report names every seam on this platform', () => {
    const rep = platformReport(currentPlatform());
    expect(rep.seams.map((s) => s.name).sort()).toEqual([
      'credential-store',
      'notification',
      'service-manager',
      'store-privacy-probe',
    ]);
  });
});
