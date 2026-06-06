/**
 * Parameter-free CloudFormation template for one vault runtime stack.
 * Built in-process so Vercel serverless can deploy without `cdk` or Docker.
 */

export interface VaultRuntimeStackSpec {
  agentId: string;
  vaultShortId: string;
  packageId: string;
  packageHistory: string;
  sessionSecretName: string;
  memwalSecretName: string | null;
  anthropicSecretName: string | null;
  tickIntervalMinutes: number;
  runtimeImageUri: string;
  walrusNetwork: 'testnet' | 'mainnet';
  enclaveUrl?: string | null;
  enclaveObjectId?: string | null;
  vpcId: string;
  subnetIds: readonly string[];
  /** AWS region for ARNs in task definition (e.g. us-east-1). */
  awsRegion: string;
}

function secretArnSub(secretName: string): object {
  return {
    'Fn::Sub': `arn:\${AWS::Partition}:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${secretName}-*`,
  };
}

function secretValueFrom(secretName: string): object {
  return {
    'Fn::Sub': `arn:\${AWS::Partition}:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${secretName}`,
  };
}

export function buildVaultRuntimeTemplate(spec: VaultRuntimeStackSpec): string {
  const tickMs = Math.max(60, spec.tickIntervalMinutes * 60) * 1000;
  const secretNames = [spec.sessionSecretName];
  if (spec.memwalSecretName) secretNames.push(spec.memwalSecretName);
  if (spec.anthropicSecretName) secretNames.push(spec.anthropicSecretName);

  const secretPolicyStatements = secretNames.map((name) => ({
    Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    Effect: 'Allow',
    Resource: secretArnSub(name),
  }));

  const containerSecrets: { Name: string; ValueFrom: object }[] = [
    { Name: 'SYNAPSE_SESSION_KEY', ValueFrom: secretValueFrom(spec.sessionSecretName) },
  ];
  if (spec.memwalSecretName) {
    containerSecrets.push({
      Name: 'MEMWAL_DELEGATE_KEY',
      ValueFrom: secretValueFrom(spec.memwalSecretName),
    });
  }
  if (spec.anthropicSecretName) {
    containerSecrets.push({
      Name: 'ANTHROPIC_API_KEY',
      ValueFrom: secretValueFrom(spec.anthropicSecretName),
    });
  }

  const environment: { Name: string; Value: string }[] = [
    { Name: 'SYNAPSE_AGENT_ID', Value: spec.agentId },
    { Name: 'SYNAPSE_PACKAGE_ID', Value: spec.packageId },
    { Name: 'SYNAPSE_WALRUS_NETWORK', Value: spec.walrusNetwork },
    { Name: 'SYNAPSE_WAL_REFUEL_AMOUNT', Value: '50000000' },
    { Name: 'SYNAPSE_WAL_REFUEL_THRESHOLD', Value: '10000000' },
    { Name: 'SYNAPSE_TICK_INTERVAL_MS', Value: String(tickMs) },
  ];
  if (spec.packageHistory) {
    environment.push({ Name: 'SYNAPSE_PACKAGE_HISTORY', Value: spec.packageHistory });
  }
  if (spec.enclaveUrl) {
    environment.push({ Name: 'SYNAPSE_ENCLAVE_URL', Value: spec.enclaveUrl });
  }
  if (spec.enclaveObjectId) {
    environment.push({ Name: 'SYNAPSE_ENCLAVE_OBJECT_ID', Value: spec.enclaveObjectId });
  }

  const template = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Synapse Vault runtime for agent ${spec.agentId}`,
    Resources: {
      Cluster: {
        Type: 'AWS::ECS::Cluster',
        Properties: {
          ClusterName: `synapse-vault-${spec.vaultShortId}`,
          ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
        },
      },
      TickLogs: {
        Type: 'AWS::Logs::LogGroup',
        Properties: {
          LogGroupName: `/synapse/vault/${spec.vaultShortId}`,
          RetentionInDays: 30,
        },
        DeletionPolicy: 'Delete',
        UpdateReplacePolicy: 'Delete',
      },
      TickTaskTaskRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'ecs-tasks.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
        },
      },
      TickTaskTaskRolePolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: 'TickTaskSecretsRead',
          Roles: [{ Ref: 'TickTaskTaskRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: secretPolicyStatements,
          },
        },
      },
      TickTaskExecutionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'ecs-tasks.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
        },
      },
      TickTaskExecutionRolePolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: 'TickTaskExecution',
          Roles: [{ Ref: 'TickTaskExecutionRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                Resource: { 'Fn::GetAtt': ['TickLogs', 'Arn'] },
              },
              {
                Effect: 'Allow',
                Action: 'ecr:GetAuthorizationToken',
                Resource: '*',
              },
              {
                Effect: 'Allow',
                Action: [
                  'ecr:BatchCheckLayerAvailability',
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                ],
                Resource: '*',
              },
              ...secretPolicyStatements,
            ],
          },
        },
      },
      TickTaskSecurityGroup: {
        Type: 'AWS::EC2::SecurityGroup',
        Properties: {
          GroupDescription: `Synapse vault runtime ${spec.vaultShortId}`,
          VpcId: spec.vpcId,
          SecurityGroupEgress: [
            {
              CidrIp: '0.0.0.0/0',
              IpProtocol: '-1',
              Description: 'Allow all outbound',
            },
          ],
        },
      },
      TickTaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: `SynapseVaultRuntime-${spec.vaultShortId}`,
          Cpu: '512',
          Memory: '1024',
          NetworkMode: 'awsvpc',
          RequiresCompatibilities: ['FARGATE'],
          RuntimePlatform: {
            CpuArchitecture: 'X86_64',
            OperatingSystemFamily: 'LINUX',
          },
          ExecutionRoleArn: { 'Fn::GetAtt': ['TickTaskExecutionRole', 'Arn'] },
          TaskRoleArn: { 'Fn::GetAtt': ['TickTaskTaskRole', 'Arn'] },
          ContainerDefinitions: [
            {
              Name: 'Runtime',
              Image: spec.runtimeImageUri,
              Essential: true,
              Command: ['--once'],
              Environment: environment,
              Secrets: containerSecrets,
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': { Ref: 'TickLogs' },
                  'awslogs-stream-prefix': 'tick',
                  'awslogs-region': spec.awsRegion,
                },
              },
            },
          ],
        },
      },
      TickTaskEventsRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { Service: 'events.amazonaws.com' },
                Action: 'sts:AssumeRole',
              },
            ],
          },
        },
      },
      TickTaskEventsRolePolicy: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: 'TickScheduleRunTask',
          Roles: [{ Ref: 'TickTaskEventsRole' }],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: 'ecs:RunTask',
                Resource: { Ref: 'TickTaskDefinition' },
                Condition: {
                  ArnEquals: {
                    'ecs:cluster': { 'Fn::GetAtt': ['Cluster', 'Arn'] },
                  },
                },
              },
              {
                Effect: 'Allow',
                Action: 'ecs:TagResource',
                Resource: {
                  'Fn::Sub': 'arn:${AWS::Partition}:ecs:${AWS::Region}:${AWS::AccountId}:task/${Cluster}/*',
                },
              },
              {
                Effect: 'Allow',
                Action: 'iam:PassRole',
                Resource: { 'Fn::GetAtt': ['TickTaskExecutionRole', 'Arn'] },
              },
              {
                Effect: 'Allow',
                Action: 'iam:PassRole',
                Resource: { 'Fn::GetAtt': ['TickTaskTaskRole', 'Arn'] },
              },
            ],
          },
        },
      },
      TickSchedule: {
        Type: 'AWS::Events::Rule',
        Properties: {
          Description: `Run Synapse Vault tick every ${spec.tickIntervalMinutes} min for ${spec.agentId}`,
          ScheduleExpression: `rate(${spec.tickIntervalMinutes} minutes)`,
          State: 'ENABLED',
          Targets: [
            {
              Id: 'Target0',
              Arn: { 'Fn::GetAtt': ['Cluster', 'Arn'] },
              RoleArn: { 'Fn::GetAtt': ['TickTaskEventsRole', 'Arn'] },
              EcsParameters: {
                TaskDefinitionArn: { Ref: 'TickTaskDefinition' },
                TaskCount: 1,
                LaunchType: 'FARGATE',
                NetworkConfiguration: {
                  AwsVpcConfiguration: {
                    AssignPublicIp: 'ENABLED',
                    SecurityGroups: [{ 'Fn::GetAtt': ['TickTaskSecurityGroup', 'GroupId'] }],
                    Subnets: [...spec.subnetIds],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };

  return JSON.stringify(template);
}
