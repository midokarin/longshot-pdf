# Build and release notes

Use Node.js 22 and `npm ci` to install the exact dependencies in `package-lock.json`.

```sh
npm ci
npm run build
npm run check:i18n
npm run check:release
```

## Local PDF generation

The upstream jsPDF 4.2.1 browser bundle includes an optional `pdfobjectnewwindow` output mode. That mode downloads PDFObject from a CDN and creates a script element in a new window. Longshot PDF never calls it: both PDF export paths use `output("arraybuffer")`.

`build/jspdf-local.mjs` removes the entire optional PDFObject output branch at build time. It operates on the upstream readable ES module, verifies its SHA-256 before parsing, and requires exactly one matching branch. It does not edit `node_modules`, hide script creation, or change image encoding, page dimensions, compression or PDF bookmarks. Updating jsPDF requires reviewing this adaptation and its source hash. Production and browser tests use the same build plugin.

## Checks

`npm run check:release` inspects the production bundle for script creation and the removed viewer code, checks CSS and license metadata, and rejects vault-wide file enumeration. It deliberately permits the filesystem access needed for user-selected output and image paths.

For the browser regression suite, build with `npm run harness`, serve the repository on port 8777, and run `npm run verify` and `npm run verify:i18n`. The current browser launchers use the Chromium cache on macOS. `node dev/verify-long-pdf.mjs` verifies actual PDF image placement and margins. These tests use Obsidian stubs, not the native Obsidian application.

## Releases

Push a tag matching `manifest.json` (for example, `0.2.4`). The release workflow builds twice to check reproducibility, performs static checks, generates provenance attestations, and publishes only the three Obsidian installation files. The workflow pins third-party Actions to commit SHAs. Historic releases are left unchanged.

Verify a downloaded file with GitHub CLI:

```sh
gh attestation verify main.js --repo midokarin/longshot-pdf
gh attestation verify styles.css --repo midokarin/longshot-pdf
```

## Review notes

The original review screenshot refers to version 0.1.0, commit `ca2339b`. Its result is historical and cannot describe newer releases. Re-run the reviewer against the new release. Direct filesystem access remains intentional and documented; a warning about it is not a claim that the plugin reads unrelated files.
