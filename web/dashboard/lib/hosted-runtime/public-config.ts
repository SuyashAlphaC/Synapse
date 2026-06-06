import {
  defaultEnclaveObjectId,
  defaultEnclaveUrl,
  defaultTickIntervalMinutes,
  hostedRuntimeRegion,
  isHostedRuntimeApiEnabled,
  isVercelDeployment,
  sharedRuntimeImageUri,
  useCloudFormationProvisioner,
} from './config';
import { NETWORK, SYNAPSE_TESTNET_ENCLAVE_OBJECT_ID } from '@/lib/synapse-config';

/** Safe to expose to the browser — no secrets. */
export function getHostedRuntimePublicConfig() {
  const defaultObjectId =
    defaultEnclaveObjectId() ??
    (NETWORK === 'testnet' ? SYNAPSE_TESTNET_ENCLAVE_OBJECT_ID : null);

  return {
    apiEnabled: isHostedRuntimeApiEnabled(),
    region: hostedRuntimeRegion(),
    sharedRuntimeImageConfigured: Boolean(sharedRuntimeImageUri()),
    defaultTickIntervalMinutes: defaultTickIntervalMinutes(),
    deployMode: hostedRuntimeDeployMode(),
    vercel: isVercelDeployment(),
    defaultEnclaveUrl: defaultEnclaveUrl(),
    defaultEnclaveObjectId: defaultObjectId,
  };
}

export function hostedRuntimeDeployMode(): 'cloudformation' | 'cdk-local' {
  return useCloudFormationProvisioner() ? 'cloudformation' : 'cdk-local';
}
