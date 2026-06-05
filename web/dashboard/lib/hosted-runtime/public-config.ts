import {
  defaultTickIntervalMinutes,
  hostedRuntimeRegion,
  isHostedRuntimeApiEnabled,
  isVercelDeployment,
  sharedRuntimeImageUri,
  useCloudFormationProvisioner,
} from './config';

/** Safe to expose to the browser — no secrets. */
export function getHostedRuntimePublicConfig() {
  return {
    apiEnabled: isHostedRuntimeApiEnabled(),
    region: hostedRuntimeRegion(),
    sharedRuntimeImageConfigured: Boolean(sharedRuntimeImageUri()),
    defaultTickIntervalMinutes: defaultTickIntervalMinutes(),
    deployMode: hostedRuntimeDeployMode(),
    vercel: isVercelDeployment(),
  };
}

export function hostedRuntimeDeployMode(): 'cloudformation' | 'cdk-local' {
  return useCloudFormationProvisioner() ? 'cloudformation' : 'cdk-local';
}
