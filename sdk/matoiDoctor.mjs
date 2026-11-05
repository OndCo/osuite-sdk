import { createControlledTransfers } from './controlled-transfers.mjs';
import { CONTROLLED_TRANSFER_PROFILE as PROFILE, QUALIFICATIONS, snapshot } from './controlled-transfers/contract.mjs';

export async function probeMatoiStatus({ config } = {}) {
  const result = { profile: PROFILE, installed: true, localConfigured: false, configured: false,
    capabilityAvailable: false, serverInstalled: null, serverConfigured: null,
    scope: null, resourceEnforced: null, qualification: null, qualificationSource: null,
    nodeVersion: process.versions.node, requiredNodeMajor: 24, code: null };
  try {
    const client = createControlledTransfers({ config });
    result.localConfigured = true;
    const capability = await client.capabilities();
    return snapshot({ ...result, capabilityAvailable: true, serverInstalled: capability.installed,
      serverConfigured: capability.configured, configured: capability.configured && capability.resourceEnforced,
      scope: capability.scope, resourceEnforced: capability.resourceEnforced,
      qualification: capability.qualification, qualificationSource: 'authenticated-capability' });
  } catch (error) {
    return snapshot({ ...result, code: error.code ?? 'PROBE_FAILED' });
  }
}

export function formatMatoiStatus(input) {
  let status;
  try { status = snapshot(input); } catch { status = {}; }
  const yesNo = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
  const authenticated = status?.profile === PROFILE && status.capabilityAvailable === true
    && status.qualificationSource === 'authenticated-capability';
  const qualification = authenticated && QUALIFICATIONS.includes(status.qualification?.status)
    ? `${status.qualification.status} (server-reported)` : 'unknown (not verified)';
  const code = typeof status?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(status.code) ? status.code : null;
  return [
    'Matoi Controlled Transfers',
    `SDK installed: ${yesNo(status?.installed)}`,
    `Local strict configuration: ${yesNo(status?.localConfigured)}`,
    `Profile configured: ${yesNo(authenticated ? status.serverConfigured : null)}`,
    `Resource scope: ${authenticated && status.scope === 'controlled-ledger' ? 'controlled-ledger' : 'unknown'}`,
    `Resource enforced: ${yesNo(authenticated ? status.resourceEnforced : null)}`,
    `Qualification: ${qualification}`,
    ...(code ? [`Diagnostic: ${code}`] : []),
    'Installing the SDK alone does not establish full-stack deployment protection.',
    'Ordinary SDK/Hook behavior is unchanged. Native Studio review is required.',
    'This probe only reads capabilities; it never prepares, approves or executes a transfer.',
  ].join('\n');
}
