---
name: add-orbstack
description: Switch NanoClaw's container runtime to OrbStack on macOS. OrbStack ships a Docker-compatible CLI, so NanoClaw needs no source changes — this skill installs OrbStack, ensures it's running, optionally patches `ensureContainerRuntimeRunning` to auto-launch it on boot, and verifies the agent container still spawns correctly. Use when the user wants OrbStack instead of Docker Desktop on Mac. Triggers on "orbstack", "switch to orbstack", "use orbstack", "add orbstack".
---

# Add OrbStack

Switches NanoClaw from Docker Desktop to [OrbStack](https://orbstack.dev) on macOS.

OrbStack is a drop-in replacement for Docker Desktop: it provides the standard `docker` CLI, daemon socket, bind-mount semantics, and `host-gateway` resolution. NanoClaw's runtime abstraction (`src/container-runtime.ts`) only ever shells out to `docker`, so the only code change this skill applies is a small enhancement to `ensureContainerRuntimeRunning` that auto-launches OrbStack when the daemon isn't responding (mirroring Docker Desktop's auto-start behavior).

**What this changes:**
- Installs OrbStack via Homebrew if missing.
- Patches `src/container-runtime.ts:ensureContainerRuntimeRunning` to detect OrbStack and `open -a OrbStack` it, then poll `docker info` until ready.
- Leaves Docker Desktop fallback intact — if both are installed, the patched function tries OrbStack first, then Docker Desktop.

**What stays the same:**
- All container-runner code (mount syntax, spawn args, `cleanupOrphans`).
- Cross-mount SQLite invariants (`journal_mode=DELETE`, host close-after-write) — OrbStack's VirtioFS-backed bind mounts honor these the same as Docker Desktop.
- The agent container image and Dockerfile.

**Why OrbStack over Docker Desktop on Mac:**
- Faster bind-mount IO (matters for the ~1s outbound delivery poll across `data/v2-sessions/*/`).
- Lighter resource footprint, no licensing requirements for personal use.
- Native Apple Silicon, faster cold start.

## Prerequisites

- macOS (OrbStack does not run on Linux or Windows).
- Homebrew installed (`brew --version`). If missing, install from https://brew.sh.

## Phase 1: Pre-flight

### Check platform

If not on macOS, stop and tell the user:

> This skill is macOS only. OrbStack is a macOS-native runtime. On Linux, just keep Docker (or switch to Podman via a future `/add-podman` skill).

```bash
test "$(uname)" = "Darwin" || echo "NOT macOS — abort"
```

### Check Homebrew

```bash
brew --version || echo "Homebrew missing — install from https://brew.sh first"
```

If missing, stop and tell the user to install Homebrew, then re-run.

### Check if already installed

```bash
brew list orbstack &>/dev/null && echo "OrbStack already installed" || echo "Not installed yet"
```

If already installed, skip to Phase 3 (verify it's running and the patch is applied).

### Check if Docker Desktop is running

```bash
pgrep -f "Docker Desktop" >/dev/null && echo "Docker Desktop is running" || echo "Docker Desktop not running"
```

If Docker Desktop is running, ask the user via AskUserQuestion:

**"Docker Desktop is currently running. OrbStack and Docker Desktop both bind to `/var/run/docker.sock` and conflict. How would you like to handle this?"**

Options:
1. **Quit Docker Desktop** — description: "Quit Docker Desktop now. OrbStack will take over the docker CLI. You can re-enable Docker Desktop later if needed."
2. **Keep both, switch manually** — description: "Leave Docker Desktop running. You'll need to quit it before OrbStack can start. Skill will pause."
3. **Cancel** — description: "Abort. Don't change anything."

If option 1: `osascript -e 'quit app "Docker Desktop"'` and wait ~5s.
If option 2: stop the skill and tell the user to re-run after quitting Docker Desktop.
If option 3: stop.

## Phase 2: Install OrbStack

```bash
brew install orbstack
```

This installs the cask. First launch needs UI consent for the network helper — the user will see an OrbStack window. Tell them:

> OrbStack is launching. Click through its first-run setup (no Kubernetes needed; the default Docker setup is enough for NanoClaw). When the OrbStack window shows "Docker is ready", come back here.

Open OrbStack:

```bash
open -a OrbStack
```

Wait for the daemon. Use AskUserQuestion to confirm:

**"Has OrbStack finished its first-run setup and shown 'Docker is ready'?"**

Options:
1. **Yes, ready** — description: "Continue to verification."
2. **Not yet** — description: "I'll wait. Re-ask in 30s."
3. **Setup failed** — description: "Stop the skill. I'll investigate."

If "Not yet", wait 30s and re-ask. If "Setup failed", stop and ask the user what error appeared.

### Verify the docker CLI now points to OrbStack

```bash
docker info --format '{{.OperatingSystem}}' 2>&1
```

Expected output: `OrbStack` (or contains "OrbStack"). If it still says `Docker Desktop`, OrbStack hasn't taken over the socket — Docker Desktop is probably still running. Re-quit Docker Desktop and retry.

```bash
docker info --format '{{.OperatingSystem}}' | grep -qi orbstack && echo OK || echo "OrbStack not active"
```

## Phase 3: Patch `ensureContainerRuntimeRunning`

The current implementation (`src/container-runtime.ts:36-57`) prints a fatal banner if `docker info` fails. Patch it to try launching OrbStack first, then Docker Desktop, before giving up. This makes NanoClaw resilient to a daemon that's not yet booted at process startup (common on login).

Read the current file first:

```bash
sed -n '35,57p' src/container-runtime.ts
```

Replace the `ensureContainerRuntimeRunning` function with this version. Use the Edit tool to replace the whole function body:

**old_string** (the existing function, 35..57):

```ts
/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}
```

**new_string**:

```ts
/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (probeRuntime()) {
    log.debug('Container runtime already running');
    return;
  }

  // Try to auto-start a known runtime app on macOS. Order: OrbStack first
  // (lighter, faster bind mounts), then Docker Desktop. On Linux the daemon
  // is managed by systemd / init — skip the GUI dance and fall through to
  // the fatal banner.
  if (os.platform() === 'darwin') {
    for (const app of ['OrbStack', 'Docker']) {
      if (!appInstalled(app)) continue;
      log.info(`Container runtime not running — launching ${app}`);
      try {
        execSync(`open -a ${app}`, { stdio: 'pipe' });
      } catch {
        continue;
      }
      if (waitForRuntime(60_000)) {
        log.info(`${app} ready`);
        return;
      }
    }
  }

  log.error('Container runtime did not become ready');
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: Container runtime failed to start                      ║');
  console.error('║                                                                ║');
  console.error('║  Agents cannot run without a container runtime. To fix:        ║');
  console.error('║  1. Ensure OrbStack or Docker Desktop is installed             ║');
  console.error('║  2. Run: docker info                                           ║');
  console.error('║  3. Restart NanoClaw                                           ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
  throw new Error('Container runtime is required but failed to start');
}

function probeRuntime(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function appInstalled(name: string): boolean {
  return (
    fs.existsSync(`/Applications/${name}.app`) ||
    fs.existsSync(`${os.homedir()}/Applications/${name}.app`)
  );
}

function waitForRuntime(timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probeRuntime()) return true;
    execSync('sleep 2');
  }
  return false;
}
```

Add the missing imports at the top of the file (after the existing `os` import, add `fs`):

```bash
grep -n "^import" src/container-runtime.ts
```

If `fs` isn't already imported, add `import fs from 'fs';` next to the existing imports.

### Validate

```bash
pnpm run build
```

Build must pass. If it fails, read the error and fix — most likely a missing import.

```bash
pnpm test --run container-runtime
```

The existing `container-runtime.test.ts` tests `cleanupOrphans` and mount helpers. They should still pass. If the test suite mocks `execSync`, the new helpers may need their mocks extended — surface any failure to the user before continuing.

## Phase 4: Verify end-to-end

### Rebuild the agent image (under OrbStack now)

```bash
./container/build.sh
```

OrbStack uses BuildKit by default. If the build fails on the first try, prune the builder cache and retry — same gotcha as Docker Desktop:

```bash
docker builder prune -af && ./container/build.sh
```

### Test bind mounts and SQLite cross-mount semantics

This is the load-bearing check. `journal_mode=DELETE` plus host close-after-write must round-trip across an OrbStack bind mount, otherwise the host and container will silently disagree on session state.

```bash
mkdir -p /tmp/nanoclaw-orbstack-check
docker run --rm -v /tmp/nanoclaw-orbstack-check:/data --entrypoint /bin/sh nanoclaw-agent:latest -c \
  "echo 'CREATE TABLE t (n INT); INSERT INTO t VALUES (42);' | sqlite3 /data/test.db && sqlite3 /data/test.db 'SELECT n FROM t'"
```

Expected output: `42`. Then read the same file from the host:

```bash
sqlite3 /tmp/nanoclaw-orbstack-check/test.db 'SELECT n FROM t'
```

Expected: `42`. If host sees `42` but container sees nothing (or vice versa), the bind-mount layer is buffering writes — stop and report this; OrbStack should not exhibit it but a stale OrbStack version might.

```bash
rm -rf /tmp/nanoclaw-orbstack-check
```

### Restart NanoClaw

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Smoke test

Send a real message through any wired channel and verify the agent responds. Watch the log for the spawn line:

```bash
tail -f logs/nanoclaw.log | grep -E "Spawning container|Container exited"
```

You should see `Spawning container` followed by `Message delivered` within a few seconds.

## Troubleshooting

**`docker info` still shows Docker Desktop after install:**
- Docker Desktop is still running and holding `/var/run/docker.sock`. Quit it: `osascript -e 'quit app "Docker Desktop"'`. OrbStack will reclaim the socket within a few seconds.

**OrbStack first-run hangs:**
- Open OrbStack from Spotlight, accept the network-helper prompt, wait for "Docker is ready". The CLI won't work until first-run is complete.

**Bind mounts read-only on the container side unexpectedly:**
- Check the host directory permissions. OrbStack runs containers as the calling user's UID by default; mounted dirs must be writable by you.

**`open -a OrbStack` returns instantly but `docker info` still fails:**
- OrbStack's daemon takes ~10–20s after launch to be ready. The patched `waitForRuntime` polls for 60s. If it consistently times out, run `orbctl status` to inspect the daemon state.

**Want to switch back to Docker Desktop:**
- Quit OrbStack: `osascript -e 'quit app "OrbStack"'`. Start Docker Desktop. The patched `ensureContainerRuntimeRunning` already prefers whichever runtime is responding to `docker info` — no code revert needed.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/container-runtime.ts` | `ensureContainerRuntimeRunning` extended with auto-launch (OrbStack → Docker Desktop) on macOS; new helpers `probeRuntime`, `appInstalled`, `waitForRuntime`. |
| (system) | OrbStack installed via `brew install orbstack`. |

No changes to `container-runner.ts`, the Dockerfile, mount syntax, or the runtime abstraction's CLI surface — OrbStack speaks Docker.
