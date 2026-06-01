import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const alt = 'Synapse Vault — Autonomous AI treasury on Sui, powered by Walrus';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Branded 1200x630 link-unfurl card. The logo is read off disk and inlined as
 * a data URI (ImageResponse can't fetch a relative path at generation time).
 */
export default async function OgImage() {
  const logo = await readFile(join(process.cwd(), 'app/icon.png'));
  const logoSrc = `data:image/png;base64,${logo.toString('base64')}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          padding: '0 96px',
          gap: 72,
          background:
            'radial-gradient(1200px 600px at 18% 30%, #12365e 0%, #0a1626 55%, #060c16 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        {/* accent rail */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 14,
            background: '#E07B2E',
          }}
        />
        <img src={logoSrc} width={300} height={300} alt="" />
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 22,
              letterSpacing: 6,
              textTransform: 'uppercase',
              color: '#5FB0E0',
              fontWeight: 600,
            }}
          >
            Sui Overflow 2026 · Walrus Track
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 800,
              color: '#F4F1EA',
              lineHeight: 1.02,
              marginTop: 10,
            }}
          >
            Synapse Vault
          </div>
          <div style={{ fontSize: 34, color: '#9FB7CC', marginTop: 18, maxWidth: 640 }}>
            Autonomous AI treasury management on Sui
          </div>
          <div style={{ fontSize: 34, color: '#5FB0E0', marginTop: 2 }}>
            powered by Walrus.
          </div>
          <div style={{ fontSize: 22, color: '#6c829a', marginTop: 26, letterSpacing: 1 }}>
            remember · audit · prove — on Walrus
          </div>
        </div>
      </div>
    ),
    size,
  );
}
