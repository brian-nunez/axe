#!/usr/bin/env python3
"""Produce an unpacked axe DevTools extension that keeps its Chrome Web Store ID.

A CRX served by the Web Store does not carry the `key` field in its manifest;
the browser injects it at install time from the CRX signature header. Unzipping
a CRX and passing it to --load-extension therefore yields an ID derived from the
filesystem path, and every managed-storage policy keyed on the store ID silently
does nothing.

This recovers the publisher's public key from the CRX3 header, selects it by the
crx_id the header declares, and writes it back into manifest.json.
"""

import argparse
import base64
import hashlib
import json
import pathlib
import shutil
import struct
import sys
import urllib.request
import zipfile

CRX_MAGIC = b"Cr24"
UPDATE_URL = (
    "https://clients2.google.com/service/update2/crx"
    "?response=redirect&acceptformat=crx2,crx3"
    "&prodversion={prodversion}&x=id%3D{extension_id}%26uc"
)


def read_fields(buf):
    """Yield (field_number, payload) for length-delimited protobuf fields."""
    i = 0
    while i < len(buf):
        key = shift = 0
        while True:
            b = buf[i]
            i += 1
            key |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        field, wire = key >> 3, key & 7
        if wire == 2:
            size = shift = 0
            while True:
                b = buf[i]
                i += 1
                size |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            yield field, buf[i:i + size]
            i += size
        elif wire == 0:
            while buf[i] & 0x80:
                i += 1
            i += 1
        else:
            raise ValueError(f"unsupported protobuf wire type {wire}")


def extension_id(public_key):
    digest = hashlib.sha256(public_key).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def publisher_key(crx):
    """Return the publisher public key, chosen by the crx_id the header declares.

    A Web Store CRX carries several proofs; the first is Google's
    countersignature, not the publisher's.
    """
    if crx[:4] != CRX_MAGIC:
        raise ValueError("not a CRX file")
    version, header_size = struct.unpack("<II", crx[4:12])
    if version != 3:
        raise ValueError(f"unsupported CRX version {version}")
    header = crx[12:12 + header_size]

    proofs, crx_id = [], None
    for field, value in read_fields(header):
        if field in (2, 3):
            for sub, payload in read_fields(value):
                if sub == 1:
                    proofs.append(payload)
        elif field == 10000:
            for sub, payload in read_fields(value):
                if sub == 1:
                    crx_id = payload
    if crx_id is None:
        raise ValueError("CRX header declares no crx_id")
    for key in proofs:
        if hashlib.sha256(key).digest()[:16] == crx_id:
            return key
    raise ValueError("no proof in the CRX header matches its declared crx_id")


def build(crx_path, dest, expect_id, expect_version):
    crx = crx_path.read_bytes()
    print(f"crx sha256      {hashlib.sha256(crx).hexdigest()}")

    key = publisher_key(crx)
    found = extension_id(key)
    if found != expect_id:
        raise SystemExit(f"extension ID mismatch: expected {expect_id}, got {found}")

    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    with zipfile.ZipFile(crx_path) as archive:
        archive.extractall(dest)

    manifest_path = dest / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if expect_version and manifest["version"] != expect_version:
        raise SystemExit(
            f"version mismatch: expected {expect_version}, got {manifest['version']}"
        )
    manifest["key"] = base64.b64encode(key).decode()
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"extension id    {found}")
    print(f"version         {manifest['version']}")
    print(f"unpacked to     {dest}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=pathlib.Path,
                        help="lock file pinning the CRX, its version and its digest; "
                             "paths inside it resolve relative to the lock file")
    parser.add_argument("--crx", type=pathlib.Path,
                        help="pinned CRX to build from; omit to download the current release")
    parser.add_argument("--dest", type=pathlib.Path, required=True,
                        help="directory to write the unpacked extension to")
    parser.add_argument("--extension-id", default="lhdoppojpmngadmnindnejefpokejbdd",
                        help="ID the built bundle must have")
    parser.add_argument("--version", help="version the CRX must contain")
    parser.add_argument("--sha256", help="digest the CRX must match")
    parser.add_argument("--prodversion", default="145.0.7632.6",
                        help="browser version reported when downloading")
    parser.add_argument("--save-crx", type=pathlib.Path,
                        help="write the downloaded CRX here so a build can be pinned to it")
    args = parser.parse_args()

    if args.lock:
        lock = json.loads(args.lock.read_text())
        args.crx = args.crx or args.lock.parent / lock["crx"]
        args.extension_id = lock.get("extension_id", args.extension_id)
        args.version = args.version or lock.get("version")
        args.sha256 = args.sha256 or lock.get("sha256")

    if args.crx:
        crx_path = args.crx
    else:
        url = UPDATE_URL.format(prodversion=args.prodversion, extension_id=args.extension_id)
        print(f"downloading     {args.extension_id}")
        with urllib.request.urlopen(url) as response:
            payload = response.read()
        crx_path = args.save_crx or args.dest.parent / f"{args.extension_id}.crx"
        crx_path.parent.mkdir(parents=True, exist_ok=True)
        crx_path.write_bytes(payload)
        print(f"saved crx       {crx_path}")

    if args.sha256:
        digest = hashlib.sha256(crx_path.read_bytes()).hexdigest()
        if digest != args.sha256:
            raise SystemExit(f"digest mismatch: expected {args.sha256}, got {digest}")

    build(crx_path, args.dest, args.extension_id, args.version)


if __name__ == "__main__":
    sys.exit(main())
