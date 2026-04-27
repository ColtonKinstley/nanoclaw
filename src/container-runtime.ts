/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

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

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
