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
  clockSyncProbeFor,
  currentPlatform,
  notificationBackendFor,
  parseW32tmStatus,
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

// Captured `w32tm /query /status` output. The daemon vets its clock before it will auto-commit,
// and the inline `timedatectl` that used to do it killed the first real Windows boot outright.
const W32TM_SYNCED = [
  'Leap Indicator: 0(no warning)',
  'Stratum: 3 (secondary reference - syncd by (S)NTP)',
  'Precision: -23 (119.209ns per tick)',
  'Root Delay: 0.0284932s',
  'Root Dispersion: 7.7961637s',
  'ReferenceId: 0x51E1F1EF (source IP:  81.225.241.239)',
  'Last Successful Sync Time: 9/5/2026 1:12:33 AM',
  'Source: time.windows.com,0x8',
  'Poll Interval: 10 (1024s)',
  '',
].join('\r\n');

const W32TM_UNSYNCED = [
  'Leap Indicator: 3(not synchronized)',
  'Stratum: 0 (unspecified)',
  'Precision: -23 (119.209ns per tick)',
  'Root Delay: 0.0000000s',
  'Root Dispersion: 0.0000000s',
  'ReferenceId: 0x00000000 (unspecified or unavailable)',
  'Last Successful Sync Time: unspecified',
  'Source: Local CMOS Clock',
  'Poll Interval: 10 (1024s)',
  '',
].join('\r\n');

// The awkward middle: the leap indicator says all is well about a clock whose only reference is
// the machine's own hardware. Nothing outside this box has ever checked it.
const W32TM_LOCAL_SOURCE = [
  'Leap Indicator: 0(no warning)',
  'Stratum: 1 (primary reference - syncd by radio clock)',
  'Source: Local CMOS Clock',
  'Poll Interval: 10 (1024s)',
  '',
].join('\r\n');

const W32TM_SERVICE_STOPPED =
  'The following error occurred: The service has not been started. (0x80070426)\r\n';

describe('w32tm status parsing', () => {
  test('a clock synchronised to a real time server reads as synced', () => {
    expect(parseW32tmStatus(W32TM_SYNCED)).toBe('synced');
  });

  test('leap indicator 3 reads as unsynced', () => {
    expect(parseW32tmStatus(W32TM_UNSYNCED)).toBe('unsynced');
  });

  test('a no-warning clock whose only source is its own hardware is NOT synced', () => {
    expect(parseW32tmStatus(W32TM_LOCAL_SOURCE)).toBe('unsynced');
  });

  test('output this parser does not understand is unknown, never a verdict', () => {
    expect(parseW32tmStatus(W32TM_SERVICE_STOPPED)).toBe('unknown');
    expect(parseW32tmStatus('')).toBe('unknown');
    // Localised Windows: the labels are translated and nothing matches.
    expect(parseW32tmStatus('Anzeige für Schaltsekunde: 0(keine Warnung)\r\nQuelle: time.windows.com')).toBe(
      'unknown',
    );
    // A leap indicator with no Source line proves only half of it.
    expect(parseW32tmStatus('Leap Indicator: 0(no warning)\r\nStratum: 3')).toBe('unknown');
  });
});

describe('clock sync probe', () => {
  test('linux asks timedatectl and maps yes/no/anything-else', async () => {
    const probe = clockSyncProbeFor('linux');
    const calls: string[][] = [];
    const runner = (out: string, code = 0): Runner => async (argv) => {
      calls.push(argv);
      return { code, stdout: out, stderr: '' };
    };
    expect(await probe.probe(runner('yes\n'))).toBe('synced');
    expect(await probe.probe(runner('no\n'))).toBe('unsynced');
    expect(await probe.probe(runner('', 1))).toBe('unknown');
    expect(calls[0]).toEqual(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value']);
  });

  test('windows asks w32tm and parses its status', async () => {
    const probe = clockSyncProbeFor('windows');
    const calls: string[][] = [];
    const runner: Runner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: W32TM_SYNCED, stderr: '' };
    };
    expect(await probe.probe(runner)).toBe('synced');
    expect(calls[0]).toEqual(['w32tm', '/query', '/status']);
  });

  test('a stopped Windows Time service is unknown, not a claim about the clock', async () => {
    const probe = clockSyncProbeFor('windows');
    const runner: Runner = async () => ({
      code: 1,
      stdout: '',
      stderr: 'The service has not been started. (0x80070426)',
    });
    expect(await probe.probe(runner)).toBe('unknown');
  });

  test('a spawn that throws ENOENT is unknown and NEVER propagates', async () => {
    // The literal failure from the first real Windows boot: the daemon died on this before it
    // served a single request.
    const throwing: Runner = async (argv) => {
      throw new Error(`ENOENT: no such file or directory, uv_spawn '${argv[0]}'`);
    };
    for (const p of ['linux', 'windows'] as const) {
      expect(await clockSyncProbeFor(p).probe(throwing)).toBe('unknown');
    }
  });

  test('macos refuses to guess rather than shipping a probe that answers the wrong question', async () => {
    const probe = clockSyncProbeFor('macos');
    expect(probe.support).toBe('unsupported');
    expect(await probe.probe()).toBe('unknown');
  });

  test('an unknown platform is unknown, not optimistically synced', async () => {
    expect(await clockSyncProbeFor('unknown').probe()).toBe('unknown');
  });
});

describe('a seam whose tool is absent refuses instead of throwing', () => {
  test('service manager reports the spawn failure as a failed restart', async () => {
    const throwing: Runner = async (argv) => {
      throw new Error(`ENOENT: no such file or directory, uv_spawn '${argv[0]}'`);
    };
    for (const p of ['linux', 'macos', 'windows'] as const) {
      const res = await serviceManagerFor(p).restart('easytier-fleet.service', throwing);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain('127');
    }
  });
});
