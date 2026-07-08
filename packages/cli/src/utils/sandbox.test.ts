/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execSync, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import type { Config, SandboxConfig } from '@google/gemini-cli-core';
import { FatalSandboxError } from '@google/gemini-cli-core';
import { start_sandbox } from './sandbox.js';
import { USER_SETTINGS_DIR } from '../config/settings.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const overrides = {
    exec: vi.fn(),
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const overrides = {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    realpathSync: vi.fn((p: string) => p),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const overrides = {
    platform: vi.fn(() => 'linux'),
    tmpdir: vi.fn(() => '/tmp'),
    homedir: vi.fn(() => '/home/user'),
  };
  return {
    ...actual,
    ...overrides,
    default: { ...actual, ...overrides },
  };
});

vi.mock('../ui/utils/ConsolePatcher.js', () => ({
  ConsolePatcher: class {
    patch() {}
    cleanup() {}
  },
}));

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockSpawn = vi.mocked(spawn);
const mockPlatform = vi.mocked(os.platform);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockRealpathSync = vi.mocked(fs.realpathSync);

function createFakeChildProcess(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

// process.argv-shaped array: [node, script, ...actual cli args]
const CLI_ARGS = ['node', 'gemini', '--foo', 'bar'];

describe('start_sandbox', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockReturnValue(false);
    // Identity by default: no symlink resolution unless a test overrides it.
    mockRealpathSync.mockImplementation((p) => p as string);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.removeAllListeners('exit');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    vi.restoreAllMocks();
  });

  describe('lxc', () => {
    const lxcConfig: SandboxConfig = { command: 'lxc', image: '' };

    // Default: container exists and is running, for tests that don't care
    // about the `lxc list` check itself.
    function mockRunningContainer(containerName = 'gemini-cli') {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (
          cmd === 'lxc' &&
          Array.isArray(args) &&
          args[0] === 'list' &&
          args[1] === containerName
        ) {
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });
    }

    it('throws a FatalSandboxError when the container is not running', async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'lxc' && Array.isArray(args) && args[0] === 'list') {
          return Buffer.from('NAME,STATE\ngemini-cli,STOPPED\n');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(lxcConfig)).rejects.toThrow(/is not running/);
    });

    it('throws a FatalSandboxError when the container does not exist', async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === 'lxc' && Array.isArray(args) && args[0] === 'list') {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(lxcConfig)).rejects.toThrow(/not found/);
    });

    it('uses GEMINI_LXC_CONTAINER to select the container name', async () => {
      vi.stubEnv('GEMINI_LXC_CONTAINER', 'my-custom-container');
      mockRunningContainer('my-custom-container');

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);

      await expect(resultPromise).resolves.toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining(['list', 'my-custom-container']),
      );
      vi.unstubAllEnvs();
    });

    it('mounts the workdir and spawns lxc exec with the expected args', async () => {
      mockRunningContainer();

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      const code = await resultPromise;

      expect(code).toBe(0);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining(['config', 'device', 'add', 'gemini-cli']),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining(['exec', 'gemini-cli']),
        { stdio: 'inherit' },
      );
    });

    it('places all lxc exec flags before the -- command delimiter', async () => {
      mockRunningContainer();
      vi.stubEnv('GEMINI_API_KEY', 'test-key');

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const spawnArgs = mockSpawn.mock.calls.find(
        ([cmd]) => cmd === 'lxc',
      )?.[1] as string[];
      expect(spawnArgs).toBeDefined();

      const dashDashIndex = spawnArgs.indexOf('--');
      const envIndex = spawnArgs.indexOf('--env');
      const cwdIndex = spawnArgs.indexOf('--cwd');

      expect(dashDashIndex).toBeGreaterThan(-1);
      expect(envIndex).toBeGreaterThan(-1);
      expect(cwdIndex).toBeGreaterThan(-1);
      // All flags must come strictly before the -- delimiter, or lxc treats
      // them as part of the in-container command instead of lxc exec flags.
      expect(envIndex).toBeLessThan(dashDashIndex);
      expect(cwdIndex).toBeLessThan(dashDashIndex);
      vi.unstubAllEnvs();
    });

    it('resolves with the spawned process exit code', async () => {
      mockRunningContainer();

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 7);

      await expect(resultPromise).resolves.toBe(7);
    });

    it('removes mounted devices when the process closes', async () => {
      mockRunningContainer();

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining(['config', 'device', 'remove', 'gemini-cli']),
      );
    });

    it('mounts additional workspace directories read-write (matching WorkspaceContext write validation)', async () => {
      mockRunningContainer();
      mockExistsSync.mockReturnValue(true);

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const fakeCliConfig = {
        getDebugMode: () => false,
        getWorkspaceContext: () => ({
          getDirectories: () => ['/extra/dir'],
        }),
      } as unknown as Config;

      const resultPromise = start_sandbox(
        lxcConfig,
        [],
        fakeCliConfig,
        CLI_ARGS,
      );
      fakeChild.emit('close', 0);
      await resultPromise;

      // Must NOT be readonly: the edit tool's write validation
      // (WorkspaceContext.isPathWithinWorkspace) and the macOS Seatbelt
      // profile both treat included directories as fully writable.
      const deviceAddCalls = mockExecFileSync.mock.calls.filter(
        ([cmd, args]) =>
          cmd === 'lxc' && Array.isArray(args) && args[2] === 'add',
      );
      const extraDirCall = deviceAddCalls.find(([, args]) =>
        (args as string[]).includes('source=/extra/dir'),
      );
      expect(extraDirCall).toBeDefined();
      expect(extraDirCall![1]).toEqual(
        expect.arrayContaining(['source=/extra/dir', 'path=/extra/dir']),
      );
      expect(extraDirCall![1]).not.toContain('readonly=true');
    });

    it('preserves paths containing spaces as single arguments (no shell splitting)', async () => {
      mockRunningContainer();

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);
      const spacedWorkdir = '/home/me/my project';
      vi.spyOn(process, 'cwd').mockReturnValue(spacedWorkdir);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      // The whole `source=<path with spaces>` string must arrive as ONE
      // execFileSync argument (execFileSync bypasses the shell, so no
      // splitting/interpretation occurs even though the path contains a
      // space).
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining([`source=${spacedWorkdir}`]),
      );
    });

    it('mounts credential material and forwards GOOGLE_APPLICATION_CREDENTIALS', async () => {
      mockRunningContainer();
      const adcFile = '/home/user/.config/adc.json';
      mockExistsSync.mockImplementation(
        (p) =>
          p === USER_SETTINGS_DIR ||
          p === '/home/user/.config/gcloud' ||
          p === adcFile,
      );
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adcFile);

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      // Credential store (~/.gemini) is mounted so cached OAuth tokens are
      // available inside the container, matching the Docker sandbox path.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining([`source=${USER_SETTINGS_DIR}`]),
      );
      // gcloud config directory is mounted read-only.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining([
          'source=/home/user/.config/gcloud',
          'readonly=true',
        ]),
      );
      // The ADC file is mounted read-only at the same path...
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining([`source=${adcFile}`, 'readonly=true']),
      );
      // ...and forwarded to the container unchanged (no path translation,
      // unlike the Docker sandbox path).
      const spawnArgs = mockSpawn.mock.calls.find(
        ([cmd]) => cmd === 'lxc',
      )?.[1] as string[];
      expect(spawnArgs).toContain(`GOOGLE_APPLICATION_CREDENTIALS=${adcFile}`);
      vi.unstubAllEnvs();
    });

    it('does not forward GOOGLE_APPLICATION_CREDENTIALS when the ADC file does not exist', async () => {
      mockRunningContainer();
      mockExistsSync.mockReturnValue(false);
      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/does/not/exist/adc.json');

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const spawnArgs = mockSpawn.mock.calls.find(
        ([cmd]) => cmd === 'lxc',
      )?.[1] as string[];
      expect(
        spawnArgs.some((a) => a.startsWith('GOOGLE_APPLICATION_CREDENTIALS=')),
      ).toBe(false);
      vi.unstubAllEnvs();
    });

    it('forwards HOME so the mounted credential store is found by os.homedir() inside the container', async () => {
      mockRunningContainer();

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      // lxc exec defaults to root (HOME=/root) unless told otherwise; without
      // this, the mounted ~/.gemini credential store would be invisible to
      // the in-container process.
      const spawnArgs = mockSpawn.mock.calls.find(
        ([cmd]) => cmd === 'lxc',
      )?.[1] as string[];
      expect(spawnArgs).toContain(`HOME=${os.homedir()}`);
    });

    it('forwards NODE_OPTIONS built from nodeArgs (e.g. autoConfigureMemory)', async () => {
      mockRunningContainer();
      // Isolate from whatever NODE_OPTIONS this test runner itself was
      // started with, so the assertion below is deterministic.
      vi.stubEnv('NODE_OPTIONS', '');

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(
        lxcConfig,
        ['--max-old-space-size=4096'],
        undefined,
        CLI_ARGS,
      );
      fakeChild.emit('close', 0);
      await resultPromise;

      const spawnArgs = mockSpawn.mock.calls.find(
        ([cmd]) => cmd === 'lxc',
      )?.[1] as string[];
      expect(spawnArgs).toContain('NODE_OPTIONS=--max-old-space-size=4096');
      vi.unstubAllEnvs();
    });
  });

  describe('windows-native', () => {
    const winConfig: SandboxConfig = {
      command: 'windows-native',
      image: '',
    };

    it('throws a FatalSandboxError when not running on win32', async () => {
      mockPlatform.mockReturnValue('linux');

      await expect(start_sandbox(winConfig)).rejects.toThrow(
        /only supported on Windows/,
      );
    });

    it('throws a FatalSandboxError when run on darwin', async () => {
      mockPlatform.mockReturnValue('darwin');

      await expect(start_sandbox(winConfig)).rejects.toThrow(FatalSandboxError);
    });

    it('spawns the gemini process with inherited stdio on win32', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);

      await expect(resultPromise).resolves.toBe(0);
      expect(mockSpawn).toHaveBeenCalledWith(
        process.argv[0],
        expect.arrayContaining(['--foo', 'bar']),
        expect.objectContaining({ stdio: 'inherit' }),
      );
    });

    it('applies icacls deny rules to existing forbidden paths', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockImplementation((p) => p === 'C:\\secret');
      vi.stubEnv(
        'GEMINI_SANDBOX_FORBIDDEN_PATHS',
        'C:\\secret;C:\\does-not-exist',
      );
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(
          'icacls "C:\\secret" /deny "DOMAIN\\user:(OI)(CI)F" /T /Q',
        ),
        expect.anything(),
      );
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining('C:\\does-not-exist'),
        expect.anything(),
      );
      vi.unstubAllEnvs();
    });

    it('snapshots ACLs before restricting and restores the exact snapshot on close', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
      const saveCall = calls.find((c) =>
        c.startsWith('icacls "C:\\secret" /save'),
      );
      const restoreCall = calls.find((c) =>
        c.startsWith('icacls "C:\\secret" /restore'),
      );
      expect(saveCall).toBeDefined();
      expect(restoreCall).toBeDefined();

      // The restore must replay the exact backup file that was saved for
      // this path — not blanket-remove all deny ACEs for the user, which
      // would also strip any pre-existing deny rules unrelated to this
      // sandbox session.
      const backupFile = saveCall!.match(/\/save "([^"]+)"/)?.[1];
      expect(backupFile).toBeTruthy();
      expect(restoreCall).toContain(`/restore "${backupFile}"`);
      expect(calls.some((c) => c.includes('/remove:d'))).toBe(false);
      vi.unstubAllEnvs();
    });

    it('skips restricting a path when its ACLs cannot be snapshotted', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = cmd as string;
        if (cmdStr === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        if (cmdStr.includes('/save')) {
          throw new Error('cannot save ACLs');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
      // Since the snapshot failed, we must not apply a restriction we can't
      // safely undo.
      expect(calls.some((c) => c.includes('/deny'))).toBe(false);
      vi.unstubAllEnvs();
    });

    it('warns (rather than silently swallowing) when the ACL restore itself fails, and keeps the backup file', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = cmd as string;
        if (cmdStr === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        if (cmdStr.includes('/restore')) {
          throw new Error('access denied');
        }
        return Buffer.from('');
      });
      const warnSpy = vi.spyOn(console, 'warn');

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      // The failure must be surfaced, not silently ignored.
      expect(
        warnSpy.mock.calls.some(
          ([msg]) =>
            typeof msg === 'string' && msg.includes('Failed to restore ACLs'),
        ),
      ).toBe(true);
      // The backup file must not be deleted when restore fails, so the
      // restriction can still be undone manually.
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('does not restore ACLs immediately on SIGINT, only once the child actually closes', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);

      // Simulate the user pressing Ctrl+C: the interactive child may
      // legitimately keep running (e.g. showing a cancel prompt), so the
      // ACL restore must NOT happen yet.
      process.emit('SIGINT');
      const callsAfterSigint = mockExecSync.mock.calls.filter(([cmd]) =>
        (cmd as string).includes('/restore'),
      );
      expect(callsAfterSigint).toHaveLength(0);

      // Only once the child actually closes should the restore happen.
      fakeChild.emit('close', 130);
      await resultPromise;

      const callsAfterClose = mockExecSync.mock.calls.filter(([cmd]) =>
        (cmd as string).includes('/restore'),
      );
      expect(callsAfterClose.length).toBeGreaterThan(0);
      vi.unstubAllEnvs();
    });

    it('does not fail when whoami cannot be determined', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          throw new Error('command not found');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(winConfig)).rejects.toThrow(
        /Failed to determine current user/,
      );
    });

    it('stores ACL backups under USER_SETTINGS_DIR, not os.tmpdir()', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const saveCall = mockExecSync.mock.calls
        .map(([cmd]) => cmd as string)
        .find((c) => c.includes('/save'));
      expect(saveCall).toContain(USER_SETTINGS_DIR);
      expect(saveCall).not.toContain('/tmp');
      vi.unstubAllEnvs();
    });

    it('throws instead of restricting when the ACL backup directory itself would be restricted', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      // The backup directory lives under USER_SETTINGS_DIR; forbidding
      // USER_SETTINGS_DIR itself would trap the backups we need to restore.
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', USER_SETTINGS_DIR);
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(winConfig)).rejects.toThrow(
        /would prevent safely backing up and restoring ACLs/,
      );
      vi.unstubAllEnvs();
    });

    it('dedupes overlapping forbidden paths, restricting only the ancestor', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv(
        'GEMINI_SANDBOX_FORBIDDEN_PATHS',
        'C:\\secret;C:\\secret\\child',
      );
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
      // Only the ancestor is restricted — /T on it already recurses into
      // the child, so restricting both would process the same files twice.
      expect(calls.some((c) => c.startsWith('icacls "C:\\secret" /deny'))).toBe(
        true,
      );
      expect(
        calls.some((c) => c.startsWith('icacls "C:\\secret\\child" /deny')),
      ).toBe(false);
    });

    it('snapshots every path before denying any of them (two-phase)', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret-a;C:\\secret-b');
      mockExecSync.mockImplementation((cmd) => {
        if (cmd === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
      const lastSaveIndex = calls.reduce(
        (last, c, i) => (c.includes('/save') ? i : last),
        -1,
      );
      const firstDenyIndex = calls.findIndex((c) => c.includes('/deny'));
      expect(lastSaveIndex).toBeGreaterThan(-1);
      expect(firstDenyIndex).toBeGreaterThan(-1);
      expect(lastSaveIndex).toBeLessThan(firstDenyIndex);
    });

    it('still attempts to restore a path whose /deny call fails partway through', async () => {
      mockPlatform.mockReturnValue('win32');
      mockExistsSync.mockReturnValue(true);
      vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
      mockExecSync.mockImplementation((cmd) => {
        const cmdStr = cmd as string;
        if (cmdStr === 'whoami') {
          return Buffer.from('DOMAIN\\user');
        }
        if (cmdStr.includes('/deny')) {
          throw new Error('access denied partway through recursive deny');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      // Even though /deny threw, the snapshot taken beforehand must still
      // be used to attempt a restore — a partial deny could have applied
      // some DENY ACEs before failing.
      const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
      expect(
        calls.some((c) => c.startsWith('icacls "C:\\secret" /restore')),
      ).toBe(true);
    });

    describe('symlink defense', () => {
      it('restricts the resolved real target, not the literal symlink path', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExistsSync.mockImplementation((p) => p === 'C:\\secret-link');
        mockRealpathSync.mockImplementation((p) =>
          p === 'C:\\secret-link' ? 'C:\\real-secret' : (p as string),
        );
        vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret-link');
        mockExecSync.mockImplementation((cmd) => {
          if (cmd === 'whoami') {
            return Buffer.from('DOMAIN\\user');
          }
          return Buffer.from('');
        });

        const fakeChild = createFakeChildProcess();
        mockSpawn.mockReturnValue(fakeChild);

        const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
        fakeChild.emit('close', 0);
        await resultPromise;

        // The real target is restricted, which — since icacls follows
        // symlinks/junctions by default — closes off access via the
        // symlink, the real path, or any other symlink pointing at the
        // same target.
        expect(mockExecSync).toHaveBeenCalledWith(
          expect.stringContaining(
            'icacls "C:\\real-secret" /deny "DOMAIN\\user:(OI)(CI)F" /T /Q',
          ),
          expect.anything(),
        );
        // The literal symlink path must NOT be separately restricted: doing
        // so would process the same underlying object twice, corrupting the
        // ACL snapshot used to restore it later (see the restore test below).
        expect(mockExecSync).not.toHaveBeenCalledWith(
          expect.stringContaining('icacls "C:\\secret-link"'),
          expect.anything(),
        );
        vi.unstubAllEnvs();
      });

      it('snapshots and restores ACLs on the resolved real target exactly once', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExistsSync.mockReturnValue(true);
        mockRealpathSync.mockImplementation((p) =>
          p === 'C:\\secret-link' ? 'C:\\real-secret' : (p as string),
        );
        vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret-link');
        mockExecSync.mockImplementation((cmd) => {
          if (cmd === 'whoami') {
            return Buffer.from('DOMAIN\\user');
          }
          return Buffer.from('');
        });

        const fakeChild = createFakeChildProcess();
        mockSpawn.mockReturnValue(fakeChild);

        const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
        fakeChild.emit('close', 0);
        await resultPromise;

        const calls = mockExecSync.mock.calls.map(([cmd]) => cmd as string);
        const saveCalls = calls.filter((c) =>
          c.startsWith('icacls "C:\\real-secret" /save'),
        );
        const restoreCalls = calls.filter((c) =>
          c.startsWith('icacls "C:\\real-secret" /restore'),
        );
        // Exactly one save/restore pair for the real target — processing it
        // twice (once via the symlink, once via the real path) is what
        // corrupted the snapshot and left the DENY ACE stuck after restore.
        expect(saveCalls).toHaveLength(1);
        expect(restoreCalls).toHaveLength(1);
        expect(calls.some((c) => c.includes('C:\\secret-link'))).toBe(false);
        expect(calls.some((c) => c.includes('/remove:d'))).toBe(false);
        vi.unstubAllEnvs();
      });

      it('does not duplicate restriction calls when the path is not a symlink', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExistsSync.mockImplementation((p) => p === 'C:\\secret');
        // realpathSync resolves to the identical path (default beforeEach behavior)
        vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
        mockExecSync.mockImplementation((cmd) => {
          if (cmd === 'whoami') {
            return Buffer.from('DOMAIN\\user');
          }
          return Buffer.from('');
        });

        const fakeChild = createFakeChildProcess();
        mockSpawn.mockReturnValue(fakeChild);

        const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
        fakeChild.emit('close', 0);
        await resultPromise;

        const denyCalls = mockExecSync.mock.calls.filter(
          ([cmd]) => typeof cmd === 'string' && cmd.includes('/deny'),
        );
        expect(denyCalls).toHaveLength(1);
        vi.unstubAllEnvs();
      });

      it('still restricts the literal path when realpathSync throws', async () => {
        mockPlatform.mockReturnValue('win32');
        mockExistsSync.mockImplementation((p) => p === 'C:\\secret');
        mockRealpathSync.mockImplementation(() => {
          throw new Error('cannot resolve');
        });
        vi.stubEnv('GEMINI_SANDBOX_FORBIDDEN_PATHS', 'C:\\secret');
        mockExecSync.mockImplementation((cmd) => {
          if (cmd === 'whoami') {
            return Buffer.from('DOMAIN\\user');
          }
          return Buffer.from('');
        });

        const fakeChild = createFakeChildProcess();
        mockSpawn.mockReturnValue(fakeChild);

        const resultPromise = start_sandbox(winConfig, [], undefined, CLI_ARGS);
        fakeChild.emit('close', 0);
        await resultPromise;

        expect(mockExecSync).toHaveBeenCalledWith(
          expect.stringContaining(
            'icacls "C:\\secret" /deny "DOMAIN\\user:(OI)(CI)F" /T /Q',
          ),
          expect.anything(),
        );
        vi.unstubAllEnvs();
      });
    });
  });
});
