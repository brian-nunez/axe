# Pinned axe DevTools extension

The Chrome Web Store update endpoint serves the current release only — there is no
version parameter. A build that fetches at image-build time would silently pick up
whatever Deque shipped that morning, which defeats the fixture's reproducibility.
So the CRX is vendored and the build is pinned to it.

`axe-extension.lock.json` records the extension ID, version, digest, and the URL the
CRX came from. The build reads it:

```bash
python3 tools/build-axe-extension.py \
  --lock vendor/axe-devtools/axe-extension.lock.json \
  --dest build/axe-extension
```

Every check is fail-closed. A wrong digest, a wrong version, or a CRX whose signature
proofs do not match its declared `crx_id` aborts the build rather than producing a
bundle with the wrong extension ID.

## Why the build cannot just unzip the CRX

A Web Store CRX carries no `key` field in its manifest — the browser injects it at
install time from the signature header. Unzip a CRX, hand it to `--load-extension`,
and Chrome derives the extension ID from the filesystem path instead. Every managed
storage policy is keyed on `lhdoppojpmngadmnindnejefpokejbdd`, so a path-derived ID
means policy silently does nothing and the failure looks like a misbehaving extension.

`build-axe-extension.py` recovers the publisher's public key from the CRX3 header and
writes it back into the manifest. The header carries several proofs and the first is
Google's countersignature, not the publisher's; the correct one is selected by the
`crx_id` in `signed_header_data`.

## Upgrading to a new release

1. Download the current CRX and save it here:

   ```bash
   python3 tools/build-axe-extension.py \
     --dest /tmp/axe-check \
     --save-crx vendor/axe-devtools/lhdoppojpmngadmnindnejefpokejbdd-<version>.crx
   ```

   The build prints the version it found and the digest of what it downloaded.

2. Update `crx`, `version`, `sha256`, and `retrieved` in `axe-extension.lock.json`.

3. Rebuild from the lock and confirm the extension still loads with ID
   `lhdoppojpmngadmnindnejefpokejbdd`.

4. Delete the superseded CRX in the same commit, so the vendored file and the lock
   never disagree.

The panel's DOM is read by the tool layer, so treat an upgrade as a change that can
break automation, not a routine dependency bump.
