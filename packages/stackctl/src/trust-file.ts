import fs from 'node:fs';
import path from 'node:path';
import { getLoadedConfig } from './config.js';
import { currentMode } from './env-base.js';
import { modeStateDir } from './log-files.js';

// Where a mode's trust file is, apart from `dev-tls.ts`, which makes it: what a service's
// environment needs, without the TLS and proxy modules a command that only resolves one would load.

/**
 * The file `NODE_EXTRA_CA_CERTS` points a mode's services at: every self-signed certificate of
 * that mode's hostnames, and the certificates `NODE_EXTRA_CA_CERTS` already named for stackctl.
 * One per mode, since two modes' sessions serve different hostnames side by side:
 * `node_modules/.stackctl/modes/<mode>/trusted.pem`.
 */
export function trustFilePath(workspaceDir: string, mode: string): string {
  return path.join(modeStateDir(workspaceDir, mode), 'trusted.pem');
}

/**
 * What a service's `NODE_EXTRA_CA_CERTS` is set to: the mode's trust file, once a session (or
 * `stackctl exec`) has written it, under a config whose proxy makes self-signed certificates.
 */
export function sessionTrustFile(workspaceDir: string): string | undefined {
  if (getLoadedConfig()?.reverseProxy?.tls !== 'self-signed') {
    return undefined;
  }
  const file = trustFilePath(workspaceDir, currentMode());
  return fs.existsSync(file) ? file : undefined;
}
