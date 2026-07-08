/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { execSync, spawn } from 'node:child_process';
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
const mockSpawn = vi.mocked(spawn);
const mockPlatform = vi.mocked(os.platform);
const mockExistsSync = vi.mocked(fs.existsSync);

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

    it('throws a FatalSandboxError when the container is not running', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          return Buffer.from('NAME,STATE\ngemini-cli,STOPPED\n');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(lxcConfig)).rejects.toThrow(/is not running/);
    });

    it('throws a FatalSandboxError when the container does not exist', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          throw new Error('not found');
        }
        return Buffer.from('');
      });

      await expect(start_sandbox(lxcConfig)).rejects.toThrow(/not found/);
    });

    it('uses GEMINI_LXC_CONTAINER to select the container name', async () => {
      vi.stubEnv('GEMINI_LXC_CONTAINER', 'my-custom-container');
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          expect(cmd).toContain('my-custom-container');
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);

      await expect(resultPromise).resolves.toBe(0);
      vi.unstubAllEnvs();
    });

    it('mounts the workdir and spawns lxc exec with the expected args', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      const code = await resultPromise;

      expect(code).toBe(0);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('lxc config device add gemini-cli'),
      );
      expect(mockSpawn).toHaveBeenCalledWith(
        'lxc',
        expect.arrayContaining(['exec', 'gemini-cli', '--']),
        { stdio: 'inherit' },
      );
    });

    it('resolves with the spawned process exit code', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 7);

      await expect(resultPromise).resolves.toBe(7);
    });

    it('removes mounted devices when the process closes', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });

      const fakeChild = createFakeChildProcess();
      mockSpawn.mockReturnValue(fakeChild);

      const resultPromise = start_sandbox(lxcConfig, [], undefined, CLI_ARGS);
      fakeChild.emit('close', 0);
      await resultPromise;

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('lxc config device remove gemini-cli'),
      );
    });

    it('mounts additional workspace directories as read-only', async () => {
      mockExecSync.mockImplementation((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('lxc list')) {
          return Buffer.from('RUNNING');
        }
        return Buffer.from('');
      });
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

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(
          'source=/extra/dir path=/extra/dir readonly=true',
        ),
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

    it('restores ACLs for restricted paths when the process closes', async () => {
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

      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(
          'icacls "C:\\secret" /remove:d "DOMAIN\\user" /T /Q',
        ),
        expect.anything(),
      );
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
  });
});
