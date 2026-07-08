/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FatalSandboxError } from '@google/gemini-cli-core';
import * as os from 'node:os';
import commandExists from 'command-exists';
import { loadSandboxConfig } from './sandboxConfig.js';
import type { Settings } from './settings.js';
import { getPackageJson } from '../utils/package.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    platform: vi.fn(),
  };
});

vi.mock('command-exists', () => ({
  default: {
    sync: vi.fn(),
  },
}));

vi.mock('../utils/package.js', () => ({
  getPackageJson: vi.fn(),
}));

const mockPlatform = vi.mocked(os.platform);
const mockCommandExistsSync = vi.mocked(commandExists.sync);
const mockGetPackageJson = vi.mocked(getPackageJson);

const emptySettings: Settings = {};

describe('loadSandboxConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPlatform.mockReturnValue('linux');
    mockCommandExistsSync.mockReturnValue(false);
    mockGetPackageJson.mockResolvedValue(undefined);
    delete process.env['SANDBOX'];
    delete process.env['GEMINI_SANDBOX'];
    delete process.env['GEMINI_SANDBOX_IMAGE'];
  });

  afterEach(() => {
    delete process.env['SANDBOX'];
    delete process.env['GEMINI_SANDBOX'];
    delete process.env['GEMINI_SANDBOX_IMAGE'];
  });

  it('returns undefined when sandbox is not requested', async () => {
    const result = await loadSandboxConfig(emptySettings, {});
    expect(result).toBeUndefined();
  });

  it('returns undefined when the SANDBOX env var is already set (already inside sandbox)', async () => {
    process.env['SANDBOX'] = 'gemini-cli-sandbox-0';
    const result = await loadSandboxConfig(emptySettings, { sandbox: true });
    expect(result).toBeUndefined();
  });

  describe('docker/podman', () => {
    it('returns a docker config with image when docker exists and sandbox is true', async () => {
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'docker');
      mockGetPackageJson.mockResolvedValue({
        config: { sandboxImageUri: 'my-image:latest' },
      } as never);

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: true,
      });

      expect(result).toEqual({ command: 'docker', image: 'my-image:latest' });
    });

    it('prefers GEMINI_SANDBOX_IMAGE over package.json image', async () => {
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'docker');
      process.env['GEMINI_SANDBOX_IMAGE'] = 'override-image:latest';
      mockGetPackageJson.mockResolvedValue({
        config: { sandboxImageUri: 'my-image:latest' },
      } as never);

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: true,
      });

      expect(result).toEqual({
        command: 'docker',
        image: 'override-image:latest',
      });
    });

    it('returns undefined when no image can be determined', async () => {
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'docker');
      mockGetPackageJson.mockResolvedValue(undefined);

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: true,
      });

      expect(result).toBeUndefined();
    });

    it('throws a FatalSandboxError when sandbox=true but no command is found', async () => {
      mockCommandExistsSync.mockReturnValue(false);

      await expect(
        loadSandboxConfig(emptySettings, { sandbox: true }),
      ).rejects.toThrow(FatalSandboxError);
    });
  });

  describe('sandbox-exec', () => {
    it('auto-detects sandbox-exec on darwin when sandbox is enabled', async () => {
      mockPlatform.mockReturnValue('darwin');
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'sandbox-exec');

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: true,
      });

      expect(result).toEqual({ command: 'sandbox-exec', image: '' });
    });

    it('does not enable any sandbox when sandbox is not requested, even on darwin', async () => {
      mockPlatform.mockReturnValue('darwin');
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'sandbox-exec');

      const result = await loadSandboxConfig(emptySettings, {});

      expect(result).toBeUndefined();
    });

    it('throws when sandbox-exec is explicitly requested on a non-macOS platform', async () => {
      mockPlatform.mockReturnValue('linux');

      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'sandbox-exec' }),
      ).rejects.toThrow(/only supported on macOS/);
    });
  });

  describe('runsc', () => {
    it('checks for docker (not runsc) as the underlying command', async () => {
      mockCommandExistsSync.mockImplementation((cmd) => cmd === 'docker');
      mockGetPackageJson.mockResolvedValue({
        config: { sandboxImageUri: 'my-image:latest' },
      } as never);

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: 'runsc',
      });

      expect(mockCommandExistsSync).toHaveBeenCalledWith('docker');
      expect(result).toEqual({ command: 'runsc', image: 'my-image:latest' });
    });

    it('throws when docker is not available for runsc', async () => {
      mockCommandExistsSync.mockReturnValue(false);

      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'runsc' }),
      ).rejects.toThrow(/Missing sandbox command 'runsc'/);
    });
  });

  describe('lxc', () => {
    it('returns an lxc config without checking for an external command', async () => {
      const result = await loadSandboxConfig(emptySettings, {
        sandbox: 'lxc',
      });

      expect(mockCommandExistsSync).not.toHaveBeenCalled();
      expect(result).toEqual({ command: 'lxc', image: '' });
    });

    it('does not require GEMINI_SANDBOX_IMAGE or package.json image', async () => {
      mockGetPackageJson.mockResolvedValue(undefined);

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: 'lxc',
      });

      expect(result).toEqual({ command: 'lxc', image: '' });
    });
  });

  describe('windows-native', () => {
    it('returns a windows-native config on win32', async () => {
      mockPlatform.mockReturnValue('win32');

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: 'windows-native',
      });

      expect(mockCommandExistsSync).not.toHaveBeenCalled();
      expect(result).toEqual({ command: 'windows-native', image: '' });
    });

    it('throws when windows-native is requested on a non-Windows platform', async () => {
      mockPlatform.mockReturnValue('linux');

      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'windows-native' }),
      ).rejects.toThrow(/only supported on Windows/);
    });

    it('throws when windows-native is requested on darwin', async () => {
      mockPlatform.mockReturnValue('darwin');

      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'windows-native' }),
      ).rejects.toThrow(FatalSandboxError);
    });
  });

  describe('validation', () => {
    it('throws a FatalSandboxError for an invalid sandbox command string', async () => {
      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'not-a-real-sandbox' }),
      ).rejects.toThrow(/Invalid sandbox command/);
    });

    it('lists all valid commands in the error message', async () => {
      await expect(
        loadSandboxConfig(emptySettings, { sandbox: 'bogus' }),
      ).rejects.toThrow(
        /docker, podman, sandbox-exec, runsc, lxc, windows-native/,
      );
    });
  });

  describe('precedence', () => {
    it('GEMINI_SANDBOX env var takes precedence over the argv value', async () => {
      process.env['GEMINI_SANDBOX'] = 'lxc';

      const result = await loadSandboxConfig(emptySettings, {
        sandbox: 'docker',
      });

      expect(result).toEqual({ command: 'lxc', image: '' });
    });

    it('settings.tools.sandbox is used when argv.sandbox is not set', async () => {
      const settings: Settings = { tools: { sandbox: 'lxc' } };

      const result = await loadSandboxConfig(settings, {});

      expect(result).toEqual({ command: 'lxc', image: '' });
    });

    it('argv.sandbox takes precedence over settings.tools.sandbox', async () => {
      const settings: Settings = { tools: { sandbox: 'docker' } };
      mockCommandExistsSync.mockReturnValue(false);

      await expect(
        loadSandboxConfig(settings, { sandbox: 'lxc' }),
      ).resolves.toEqual({ command: 'lxc', image: '' });
    });
  });
});
