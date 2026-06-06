import {
  defaultTickIntervalMinutes,
  hostedRuntimeRegion,
  isHostedRuntimeApiEnabled,
  isVercelDeployment,
  sharedRuntimeImageUri,
  sharedSynapseEnclaveDefaults,
  synapseManagedEnclaveAvailable,
  useCloudFormationProvisioner,
} from './config';
import { NETWORK, SYNAPSE_ENCLAVE_DOCS_URL } from '@/lib/synapse-config';

/** Safe to expose to the browser — no secrets. */
export function getHostedRuntimePublicConfig() {
  const shared = sharedSynapseEnclaveDefaults();
  const sharedSynapseEnclave =
    shared.url && shared.objectId
      ? { url: shared.url, objectId: shared.objectId }
      : null;

  return {
    apiEnabled: isHostedRuntimeApiEnabled(),
    region: hostedRuntimeRegion(),
    sharedRuntimeImageConfigured: Boolean(sharedRuntimeImageUri()),
    defaultTickIntervalMinutes: defaultTickIntervalMinutes(),
    deployMode: hostedRuntimeDeployMode(),
    vercel: isVercelDeployment(),
    /** @deprecated Prefer sharedSynapseEnclave — kept for backward compatibility. */
    defaultEnclaveUrl: shared.url,
    /** @deprecated Prefer sharedSynapseEnclave — kept for backward compatibility. */
    defaultEnclaveObjectId: shared.objectId,
    sharedSynapseEnclave,
    synapseManagedEnclaveAvailable: synapseManagedEnclaveAvailable(),
    enclaveDocsUrl: SYNAPSE_ENCLAVE_DOCS_URL,
    network: NETWORK,
  };
}

export function hostedRuntimeDeployMode(): 'cloudformation' | 'cdk-local' {
  return useCloudFormationProvisioner() ? 'cloudformation' : 'cdk-local';
}
