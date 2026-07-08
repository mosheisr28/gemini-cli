# Sandboxing in the Gemini CLI

This document provides a guide to sandboxing in the Gemini CLI, including
prerequisites, quickstart, and configuration.

## Prerequisites

Before using sandboxing, you need to install and set up the Gemini CLI:

```bash
npm install -g @google/gemini-cli
```

To verify the installation

```bash
gemini --version
```

## Overview of sandboxing

Sandboxing isolates potentially dangerous operations (such as shell commands or
file modifications) from your host system, providing a security barrier between
AI operations and your environment.

The benefits of sandboxing include:

- **Security**: Prevent accidental system damage or data loss.
- **Isolation**: Limit file system access to project directory.
- **Consistency**: Ensure reproducible environments across different systems.
- **Safety**: Reduce risk when working with untrusted code or experimental
  commands.

## Sandboxing methods

Your ideal method of sandboxing may differ depending on your platform and your
preferred container solution.

### 1. macOS Seatbelt (macOS only)

Lightweight, built-in sandboxing using `sandbox-exec`.

**Default profile**: `permissive-open` - restricts writes outside project
directory but allows most other operations.

### 2. Container-based (Docker/Podman)

Cross-platform sandboxing with complete process isolation.

**Note**: Requires building the sandbox image locally or using a published image
from your organization's registry.

### 3. gVisor / runsc (Linux only)

Enhanced container sandboxing using [gVisor](https://gvisor.dev/), which
intercepts and handles system calls in user space for stronger isolation.

**Requirements**: Docker must be installed and gVisor (`runsc`) must be
configured as a Docker runtime.

```bash
export GEMINI_SANDBOX=runsc
gemini -p "analyze the code"
```

### 4. LXC (Linux Containers)

Sandboxing within a pre-existing, user-managed LXC container using `lxc exec`.
Unlike Docker/Podman, LXC does not create a new container per session — it
executes commands inside a running container you manage.

**Requirements**: LXC must be installed and a container must already exist and
be running.

```bash
# Create and start an LXC container (one-time setup)
lxc launch ubuntu:22.04 gemini-cli
lxc exec gemini-cli -- npm install -g @google/gemini-cli

# Run with LXC sandbox
export GEMINI_LXC_CONTAINER=gemini-cli
export GEMINI_SANDBOX=lxc
gemini -p "run the tests"
```

### 5. Windows Native / TrusteeOS (Windows only)

Native Windows sandboxing using Windows Access Control Lists (ACLs) and the
Windows trustee model. This applies file system restrictions using `icacls.exe`
to deny access to sensitive paths, providing OS-level isolation without
requiring a container runtime.

**Requirements**: Windows OS only. No additional software needed.

```bash
# Restrict access to specific paths
set GEMINI_SANDBOX_FORBIDDEN_PATHS=C:\Users\secret;C:\sensitive-data
set GEMINI_SANDBOX=windows-native
gemini -p "analyze the code"
```

**Symlink resolution**: Each forbidden path is resolved to its real path with
`fs.realpathSync` before the `DENY` ACE is applied, and the restriction is
applied to that resolved path. If a forbidden path is a symlink (or
junction/reparse point), the underlying real target is restricted rather than
the link itself — icacls follows links by default, so this closes off access via
the symlink, the real path, or any other symlink pointing at the same target.
See [Security notes](#security-notes) for the current scope and known
limitations of this protection.

## Quickstart

```bash
# Enable sandboxing with command flag
gemini -s -p "analyze the code structure"

# Use environment variable
export GEMINI_SANDBOX=true
gemini -p "run the test suite"

# Configure in settings.json
{
  "tools": {
    "sandbox": "docker"
  }
}
```

## Configuration

### Enable sandboxing (in order of precedence)

1. **Command flag**: `-s`/`--sandbox` — a boolean switch only (auto-detects a
   backend: sandbox-exec on macOS, otherwise docker/podman). It cannot select a
   specific backend by name, since this command also accepts a positional query
   (e.g. `gemini -s "do X"`) and a value-accepting flag here would swallow that
   query instead of leaving it as the prompt.
2. **Environment variable**:
   `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc|windows-native` —
   the only way to select `runsc`, `lxc`, or `windows-native` explicitly.
3. **Settings file**: `"sandbox": true` (or a specific backend name string) in
   the `tools` object of your `settings.json` file (e.g.,
   `{"tools": {"sandbox": "lxc"}}`).

### macOS Seatbelt profiles

Built-in profiles (set via `SEATBELT_PROFILE` env var):

- `permissive-open` (default): Write restrictions, network allowed
- `permissive-closed`: Write restrictions, no network
- `permissive-proxied`: Write restrictions, network via proxy
- `restrictive-open`: Strict restrictions, network allowed
- `restrictive-closed`: Maximum restrictions

### Custom Sandbox Flags

For container-based sandboxing, you can inject custom flags into the `docker` or
`podman` command using the `SANDBOX_FLAGS` environment variable. This is useful
for advanced configurations, such as disabling security features for specific
use cases.

**Example (Podman)**:

To disable SELinux labeling for volume mounts, you can set the following:

```bash
export SANDBOX_FLAGS="--security-opt label=disable"
```

Multiple flags can be provided as a space-separated string:

```bash
export SANDBOX_FLAGS="--flag1 --flag2=value"
```

## Linux UID/GID handling

The sandbox automatically handles user permissions on Linux. Override these
permissions with:

```bash
export SANDBOX_SET_UID_GID=true   # Force host UID/GID
export SANDBOX_SET_UID_GID=false  # Disable UID/GID mapping
```

## LXC configuration

| Variable               | Description                                |
| ---------------------- | ------------------------------------------ |
| `GEMINI_LXC_CONTAINER` | LXC container name (default: `gemini-cli`) |

## Windows Native (TrusteeOS) configuration

| Variable                         | Description                                         |
| -------------------------------- | --------------------------------------------------- |
| `GEMINI_SANDBOX_FORBIDDEN_PATHS` | Semicolon-separated list of paths to deny access to |

The Windows native sandbox applies `DENY` ACEs (Access Control Entries) to
specified paths using `icacls.exe`. Restrictions are automatically removed when
the session ends.

Before applying a restriction, each forbidden path is resolved with
`fs.realpathSync`, and the restriction is applied to the resolved path. If the
resolved real path differs from the path you specified (i.e. it is a symlink or
junction), only the real target is restricted — icacls follows links by default,
so restricting the real target already blocks access through the symlink, the
real path itself, or any other symlink pointing at the same target. This
mirrors, at a smaller scope, the symlink-resolution approach used for the
workspace-trust boundary in other sandbox backends.

## Troubleshooting

### Common issues

**"Operation not permitted"**

- Operation requires access outside sandbox.
- Try more permissive profile or add mount points.

**Missing commands**

- Add to custom Dockerfile.
- Install via `sandbox.bashrc`.

**Network issues**

- Check sandbox profile allows network.
- Verify proxy configuration.

### Debug mode

```bash
DEBUG=1 gemini -s -p "debug command"
```

**Note:** If you have `DEBUG=true` in a project's `.env` file, it won't affect
gemini-cli due to automatic exclusion. Use `.gemini/.env` files for gemini-cli
specific debug settings.

### Inspect sandbox

```bash
# Check environment
gemini -s -p "run shell command: env | grep SANDBOX"

# List mounts
gemini -s -p "run shell command: mount | grep workspace"
```

## Security notes

- Sandboxing reduces but doesn't eliminate all risks.
- Use the most restrictive profile that allows your work.
- Container overhead is minimal after first build.
- GUI applications may not work in sandboxes.

### Known limitations of runsc, lxc, and windows-native

The `runsc`, `lxc`, and `windows-native` sandbox types are independent,
lighter-weight implementations and have **not** been validated against a real
Windows/LXC/gVisor environment as part of this change (this fork's CI does not
have such runners). Before relying on them for untrusted or adversarial input,
be aware of the following:

- **windows-native**: Restricts only the paths listed in
  `GEMINI_SANDBOX_FORBIDDEN_PATHS`, resolved through one level of symlink/
  junction indirection (see
  [Windows Native configuration](#windows-native-trusteeos-configuration)
  above). It does not implement process-level integrity labeling (e.g. Low
  Mandatory Integrity Level), does not sandbox network access, and does not
  restrict the _workspace_ — it is a deny-list, not a default-deny sandbox.
  Treat it as a defense-in-depth layer, not a substitute for running untrusted
  code in a VM or container.
- **lxc**: Executes inside a container you create and manage yourself; the
  strength of the isolation is entirely determined by how that container is
  configured (LXC's own confinement, not something this integration adds on
  top). Mounted directories other than the workdir are best-effort read-only and
  rely on the LXC container's own enforcement of `readonly=true`.
- **runsc**: Reuses the existing Docker/Podman code path with `--runtime=runsc`
  added; it inherits the same volume-mount and environment-forwarding behavior
  as the standard Docker sandbox, so review that section's security notes as
  well.

If you need stronger, more thoroughly audited platform-native sandboxing,
consider using Docker/Podman or macOS Seatbelt, which have broader real-world
usage and testing within this project.

## Related documentation

- [Configuration](../get-started/configuration.md): Full configuration options.
- [Commands](./commands.md): Available commands.
- [Troubleshooting](../troubleshooting.md): General troubleshooting.
