// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { expandHome, patchConfig } from './config';
import { run } from './util';
import type { FleetConfig, RepoConfig } from './types';
import type { Pairing } from './pairing';
import type { Syncer } from './syncer';

export interface SyncSetupDeps {
  cfg: FleetConfig;
  pairing: Pick<Pairing, 'mintCode' | 'redeem'>;
  syncer: Pick<Syncer, 'adoptRepo' | 'ensureFleetRemotes'>;
  auditAppend: (kind: string, detail: Record<string, unknown>) => Promise<unknown>;
  activateRepo: (repo: RepoConfig) => void;
  status: () => unknown;
  persist?: typeof patchConfig;
}

export class SyncSetup {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: SyncSetupDeps) {}

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    if (name === 'fleet.sync_status') return this.deps.status();
    const perform = () => this.mutate(name, args);
    const pending = this.queue.then(perform, perform);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private async mutate(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { cfg, auditAppend } = this.deps;
    if (!cfg.admin.enabled || cfg.admin.agentOrigin !== 'allow') throw new Error('sync setup requires the admin lane and agent-origin access');
    if (typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 1024) throw new Error('a reason of 1-1024 characters is required');
    const runId = randomUUID();
    if (name === 'fleet.pair_code') {
      await auditAppend('sync-setup-requested', { runId, operation: name, reason: args.reason });
      const result = this.deps.pairing.mintCode();
      // Pairing codes are returned to the caller, never copied to the audit trail.
      await auditAppend('sync-setup-completed', { runId, operation: name });
      return result;
    }
    if (name === 'fleet.pair_redeem') {
      if (typeof args.code !== 'string' || !/^[A-Za-z0-9 -]{12,64}$/.test(args.code) ||
          typeof args.host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(args.host) ||
          !Number.isInteger(args.port) || (args.port as number) < 1 || (args.port as number) > 65535) throw new Error('invalid pairing code, host or port');
      await auditAppend('sync-setup-requested', { runId, operation: name, host: args.host, port: args.port, reason: args.reason });
      const result = await this.deps.pairing.redeem({ code: args.code, host: args.host, port: args.port as number });
      await auditAppend('sync-setup-completed', { runId, operation: name, ok: result.ok });
      if (!result.ok) throw new Error(`pairing refused: ${JSON.stringify(result)}`);
      return result;
    }
    if (name !== 'fleet.repo_add') throw new Error('unknown sync setup operation');
    if (typeof args.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(args.name) || args.name === '.' || args.name === '..') throw new Error('invalid repository name');
    if (typeof args.path !== 'string' || /[\r\n\0]/.test(args.path) || !isAbsolute(expandHome(args.path))) throw new Error('repository path must be absolute or home-relative');
    const path = await realpath(expandHome(args.path));
    const existing = cfg.repos.find((r) => r.name === args.name);
    if (existing) {
      if (await realpath(existing.path) !== path) throw new Error('repository name already has another path');
      return { registered: true, alreadyRegistered: true, repo: existing };
    }
    for (const repo of cfg.repos) {
      if (await realpath(repo.path) === path) throw new Error('repository path is already registered');
    }
    const git = async (argv: string[]) => {
      const result = await run(['git', '-C', path, ...argv], { timeoutMs: 10000 });
      if (result.code !== 0) throw new Error(`git ${argv[0]} failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    };
    if (await realpath(await git(['rev-parse', '--show-toplevel'])) !== path) throw new Error('path must be the repository root');
    const branch = `sync/${cfg.machine}`;
    const target = await run(['git', '-C', path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeoutMs: 10000 });
    if (target.code === 0 && target.stdout.trim() !== await git(['rev-parse', 'HEAD'])) throw new Error('existing sync branch differs from HEAD; refusing to switch');
    await auditAppend('sync-setup-requested', { runId, operation: name, repo: args.name, path, reason: args.reason });
    const repo: RepoConfig = { name: args.name, path, peerOnly: true };
    await this.deps.syncer.adoptRepo(path, cfg.machine);
    await this.deps.syncer.ensureFleetRemotes(repo);
    await (this.deps.persist ?? patchConfig)((raw) => {
      const repos = Array.isArray(raw.repos) ? [...raw.repos] : [];
      if (repos.some((r: any) => r.name === repo.name || r.path === path)) throw new Error('repository was registered concurrently; inspect before retrying');
      raw.repos = [...repos, repo];
    });
    this.deps.activateRepo(repo);
    await auditAppend('sync-setup-completed', { runId, operation: name, repo: repo.name, branch });
    return { registered: true, repo, branch, restartRequired: false };
  }
}
