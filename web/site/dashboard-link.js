/**
 * Single source of truth for the dashboard base URL on the marketing site.
 *
 * The marketing site is static HTML deployed to Walrus Sites; the Vault
 * dashboard is a Next.js app deployed elsewhere (Vercel/Cloudflare/etc).
 * To keep the marketing site portable, every "Mint a vault" / "Open
 * dashboard" link is templated at runtime against the value below.
 *
 * To re-deploy with a different dashboard URL: change `DASHBOARD_BASE`
 * here, re-publish — no rebuild, no HTML edits.
 *
 * Recognized link patterns in the HTML (any host, path matches):
 *   …/mint       → DASHBOARD_BASE + /mint
 *   …/dashboard  → DASHBOARD_BASE + /dashboard
 */
(function () {
  // Set to the live deployment URL when you publish. Empty string ('')
  // makes every templated link land on the current origin — useful when
  // the dashboard and the site share a domain.
  var DASHBOARD_BASE = 'https://app.synapsevault.xyz';

  function rewrite() {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i += 1) {
      var href = anchors[i].getAttribute('href') || '';
      // Match /mint or /dashboard at the end of any URL, ignoring host.
      // Catches the localhost:3001 placeholders and any prior absolute
      // URL we shipped — the latest constant always wins.
      var m = href.match(/\/(mint|dashboard)(\/.*)?$/);
      if (!m) continue;
      var suffix = m[2] || '';
      anchors[i].setAttribute('href', DASHBOARD_BASE + '/' + m[1] + suffix);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rewrite);
  } else {
    rewrite();
  }
})();
