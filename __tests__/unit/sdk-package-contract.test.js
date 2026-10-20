import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OSuite } from '../../sdk/osuite.js';
import { OSuite as LegacyOSuite } from '../../sdk/legacy/osuite-v1.js';

const sdkPath = path.join(process.cwd(), 'sdk');
const readme = readFileSync(path.join(sdkPath, 'README.md'), 'utf8');

describe('published SDK contract', () => {
  it('includes the license notice declared in the package manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(sdkPath, 'package.json'), 'utf8'));
    expect(manifest.license).toBe('MIT');
    expect(manifest.files).toContain('LICENSE');
    const licensePath = path.join(sdkPath, 'LICENSE');
    expect(existsSync(licensePath)).toBe(true);
    const license = readFileSync(licensePath, 'utf8');
    expect(license).toContain('Permission is hereby granted, free of charge');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('does not advertise missing identity methods through the legacy alias', () => {
    for (const method of ['createPairing', 'waitForPairing', 'getPairing', 'registerIdentity', 'getIdentities']) {
      if (typeof LegacyOSuite.prototype[method] !== 'function') {
        expect(readme).not.toContain(`osuite.${method}(`);
      }
    }
    expect(readme).toContain('/api/pairings');
    expect(readme).toContain('/api/identities');
  });

  it('describes the legacy subpath as the v2 compatibility alias it exports', () => {
    expect(LegacyOSuite).toBe(OSuite);
    expect(readme).toContain('`osuite/legacy` currently aliases the v2 client');
    expect(readme).not.toContain('188+ methods');
    expect(readme).not.toContain('Methods moved to v1 only');
  });
});
