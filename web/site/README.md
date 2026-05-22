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

## Deploy to Walrus Sites

Prerequisites: the `site-builder` CLI from
<https://docs.wal.app/walrus-sites/intro.html>, and a funded Sui wallet
with WAL tokens.

```bash
cd web/site
site-builder publish --epochs 100 .
```

The `ws-resources.json` in this directory pins:

- routes (`/`, `/styles.css`, `/calculator.js`, `/favicon.svg`)
- cache headers (immutable for static assets, short TTL for HTML)
- site metadata for the on-chain `Site` object

After publishing, the CLI prints a `*.wal.app` subdomain. To bind a
custom domain, register a SuiNS name and point it at the site object
ID per the Walrus Sites docs.

To re-publish after content edits:

```bash
site-builder update --epochs 100 <site-object-id> .
```

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

## Dashboard URL

Every "Mint a vault" / "Open dashboard" link on the site is rewritten at
load time against the `DASHBOARD_BASE` constant in
[`dashboard-link.js`](./dashboard-link.js). Update that one constant
when the dashboard moves; no other HTML edits required.
