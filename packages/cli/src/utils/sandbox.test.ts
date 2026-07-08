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

    it('mounts additional workspace directories as read-only', async () => {
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

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining([
          'source=/extra/dir',
          'path=/extra/dir',
          'readonly=true',
        ]),
      );
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

    describe('symlink defense', () => {
      it('restricts both a symlinked forbidden path and its real target', async () => {
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

        // The symlink itself is restricted...
        expect(mockExecSync).toHaveBeenCalledWith(
          expect.stringContaining(
            'icacls "C:\\secret-link" /deny "DOMAIN\\user:(OI)(CI)F" /T /Q',
          ),
          expect.anything(),
        );
        // ...and so is the real target it resolves to, closing the bypass.
        expect(mockExecSync).toHaveBeenCalledWith(
          expect.stringContaining(
            'icacls "C:\\real-secret" /deny "DOMAIN\\user:(OI)(CI)F" /T /Q',
          ),
          expect.anything(),
        );
        vi.unstubAllEnvs();
      });

      it('snapshots and restores ACLs on both the symlink and its real target', async () => {
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
        expect(
          calls.some((c) => c.startsWith('icacls "C:\\secret-link" /save')),
        ).toBe(true);
        expect(
          calls.some((c) => c.startsWith('icacls "C:\\secret-link" /restore')),
        ).toBe(true);
        expect(
          calls.some((c) => c.startsWith('icacls "C:\\real-secret" /save')),
        ).toBe(true);
        expect(
          calls.some((c) => c.startsWith('icacls "C:\\real-secret" /restore')),
        ).toBe(true);
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
