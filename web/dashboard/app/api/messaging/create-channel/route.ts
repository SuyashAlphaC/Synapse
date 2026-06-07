import { NextResponse } from 'next/server';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { callMessagingBridge } from '@/lib/messaging-bridge-server';
import { loadLiveVault } from '@/lib/vault-state';
import { NETWORK, SUI_FULLNODE_URL } from '@/lib/synapse-config';

export const runtime = 'nodejs';
export const maxDuration = 120;

function parseVaultIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('0x')),
    ),
  ];
}

function normalizeOwnerKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as { suiPrivateKey?: string };
    const sui = parsed.suiPrivateKey?.trim();
    if (sui?.startsWith('suiprivkey')) return sui;
    throw new Error('owner key JSON must include suiPrivateKey (suiprivkey…)');
  }
  if (trimmed.startsWith('suiprivkey')) return trimmed;
  throw new Error('ownerKey must be a suiprivkey… string or .key JSON with suiPrivateKey');
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      ownerKey?: string;
      vaultIds?: string;
    };
    if (!body.ownerKey?.trim()) {
      return NextResponse.json({ error: 'ownerKey required (suiprivkey or .key JSON)' }, { status: 400 });
    }
    if (!body.vaultIds?.trim()) {
      return NextResponse.json(
        { error: 'vaultIds required — this vault + peer vault ids, one per line' },
        { status: 400 },
      );
    }

    const vaultIds = parseVaultIds(body.vaultIds);
    if (vaultIds.length === 0) {
      return NextResponse.json({ error: 'no valid vault ids (0x…)' }, { status: 400 });
    }

    const ownerKey = normalizeOwnerKey(body.ownerKey);
    const fullnodeUrl = process.env.SUI_FULLNODE_URL ?? SUI_FULLNODE_URL;
    const client = new SuiJsonRpcClient({ network: NETWORK, url: fullnodeUrl });

    const sessionAddresses: string[] = [];
    for (const vaultId of vaultIds) {
      const live = await loadLiveVault({ client, vaultId });
      if (!live.identity.sessionAddr.startsWith('0x')) {
        return NextResponse.json({ error: `vault ${vaultId} missing session_addr` }, { status: 400 });
      }
      sessionAddresses.push(live.identity.sessionAddr);
    }

    const initialMembers = [...new Set(sessionAddresses)];
    const result = (await callMessagingBridge(
      { op: 'createChannel', initialMembers },
      { ownerKey, fullnodeUrl, network: 'testnet' },
    )) as {
      channelId: string;
      digest: string;
      initialMembers: string[];
    };

    return NextResponse.json({
      channelId: result.channelId,
      digest: result.digest,
      sessionMembers: result.initialMembers,
      vaultIds,
      message:
        'Channel created. Attach it to each vault (inbox=outbox) with your owner wallet, then rebalance a peer to emit signals.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
