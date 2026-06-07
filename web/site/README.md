# @synapse-core/site

Marketing site for Synapse Vault. Static HTML/CSS/JS so it deploys directly
to Walrus Sites without a build step.

## Preview locally

```bash
cd web/site
npx --yes serve -p 4321 .
# open http://localhost:4321
```

Or just `open index.html` — there's no bundler.

## Deployed to Walrus Sites (testnet)

| | |
|---|---|
| **Site Object ID** | `0x55c33a39757a4487ca8cebdaffd5b7b9f9ba9601456a82ef5f031c689ae0001a` |
| **Base36** | `24y93b3an65e8kuksi0o1wpehgq55msa4163bjdq88ayycgx7e` |

> On testnet, `wal.app` portal only serves mainnet sites. To browse
> the testnet site, self-host a portal or use a third-party testnet portal.

### Re-deploy after edits

Prerequisites: the `site-builder` CLI from
<https://docs.wal.app/docs/sites/getting-started/installing-the-site-builder>,
and a funded Sui testnet wallet with SUI + WAL tokens.

```bash
cd web/site
site-builder --context testnet deploy --epochs 5 .
```

The `ws-resources.json` already contains the `object_id` from the
initial deployment, so `deploy` will update the existing site.

To publish a brand-new site instead, delete the `object_id` field from
`ws-resources.json` before running `deploy`.

## File layout

```
web/site/
├── index.html         — landing page (hero, how-it-works, pricing, FAQ, CTA)
├── styles.css         — Sui Overflow 2026 theme tokens
├── calculator.js      — interactive AUM pricing calculator
├── performance.js     — strategy comparison chart
├── scroll-reveal.js   — fade-in on scroll
├── dashboard-link.js  — single source of truth for the Vault dashboard URL
├── favicon.svg        — four-square logo
├── ws-resources.json  — Walrus Sites manifest
└── README.md
```

No bundler, no framework, no build step. Edit the HTML and re-publish.

## Walrus Track copy

The landing page (`index.html`) is aligned with the repo's Walrus Track narrative:

- **`#walrus`** — judge-facing feature grid, tick loop, live proof ids, links to `SUBMISSION.md` and `THREAT_MODEL.md`
- **Hero / how / tech** — recall → reason → act → publish → coordinate → remember
- **Marquee + footer** — stack integrations and GitHub submission links

Executive summary for judges lives at the repo root: [`SUBMISSION.md`](../../SUBMISSION.md).

## Dashboard URL

Every "Mint a vault" / "Open dashboard" link on the site is rewritten at
load time against the `DASHBOARD_BASE` constant in
[`dashboard-link.js`](./dashboard-link.js). Update that one constant
when the dashboard moves; no other HTML edits required.
