#!/usr/bin/env python3
"""Import and verify the approved, immutable T3 Code source archive.

Downloads are deliberately separate. This script never installs dependencies,
runs upstream scripts, changes Git state, or overwrites an existing import.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
from datetime import datetime, timezone


COMMIT = "fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92"
REPOSITORY = "https://github.com/pingdotgg/t3code"
ARCHIVE_URL = f"https://codeload.github.com/pingdotgg/t3code/tar.gz/{COMMIT}"
PROVENANCE = ".autoops-source"


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def blob_hash(data):
    return hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def import_source(args):
    archive = args.archive.resolve()
    commit_path, tree_path = args.commit_json.resolve(), args.tree_json.resolve()
    commit, tree = read_json(commit_path), read_json(tree_path)
    if commit.get("sha") != COMMIT:
        raise ValueError("The commit metadata does not match the approved commit")
    if tree.get("truncated") is not False:
        raise ValueError("The recursive upstream tree must be complete")
    # GitHub accepts a commit as a tree URL; some responses retain the requested
    # ref in `sha`, while the commit object always supplies the canonical tree.
    if tree.get("sha") not in (COMMIT, commit["tree"]["sha"]):
        raise ValueError("The tree metadata does not match this commit")
    entries = {entry["path"]: entry for entry in tree["tree"]}
    expected = {name: entry for name, entry in entries.items() if entry["type"] == "blob"}
    gitlinks = [entry for entry in entries.values() if entry["type"] == "commit"]
    destination = args.destination.resolve()
    if destination.exists():
        raise ValueError("Destination already exists; run verify instead of overwriting it")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = destination.with_name(destination.name + ".source-import-pending")
    if staging.exists():
        raise ValueError(f"Previous staging directory exists: {staging}")
    staging.mkdir()
    files, seen = [], set()
    prefix = f"t3code-{COMMIT}/"
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle:
                if member.name.rstrip("/") == prefix.rstrip("/"):
                    continue
                if not member.name.startswith(prefix):
                    raise ValueError(f"Unexpected archive root: {member.name}")
                relative = member.name[len(prefix):].rstrip("/")
                parts = PurePosixPath(relative).parts
                if not parts or ".." in parts or PurePosixPath(relative).is_absolute():
                    raise ValueError(f"Unsafe archive member: {relative}")
                if member.isdir():
                    continue
                if ".git" in parts:
                    raise ValueError(f"Unexpected repository metadata: {relative}")
                entry = expected.get(relative)
                if entry is None or relative in seen:
                    raise ValueError(f"Unexpected or duplicate source file: {relative}")
                target = staging.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.issym():
                    if entry["mode"] != "120000":
                        raise ValueError(f"Unexpected symlink: {relative}")
                    data = member.linkname.encode()
                    if not (target.parent / member.linkname).resolve().is_relative_to(staging):
                        raise ValueError(f"Symlink escapes source root: {relative}")
                elif member.isfile() and entry["mode"] in ("100644", "100755"):
                    with bundle.extractfile(member) as stream:
                        data = stream.read()
                else:
                    raise ValueError(f"Unsupported source member type: {relative}")
                if len(data) != entry["size"] or blob_hash(data) != entry["sha"]:
                    raise ValueError(f"Official Git blob hash mismatch: {relative}")
                if member.issym():
                    target.symlink_to(member.linkname)
                else:
                    target.write_bytes(data)
                    target.chmod(0o755 if entry["mode"] == "100755" else 0o644)
                files.append({
                    "path": relative,
                    "gitMode": entry["mode"],
                    "gitBlobSha1": entry["sha"],
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                })
                seen.add(relative)
        missing = sorted(set(expected) - seen)
        if missing:
            raise ValueError(f"Archive is missing {len(missing)} tracked blobs: {missing[:10]}")
        license_text = (staging / "LICENSE").read_text()
        if "MIT License" not in license_text or "Copyright (c) 2026 T3 Tools Inc." not in license_text:
            raise ValueError("The expected upstream MIT license was not found")
        provenance = staging / PROVENANCE
        provenance.mkdir()
        files.sort(key=lambda item: item["path"])
        with (provenance / "files.jsonl").open("w") as stream:
            for item in files:
                stream.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        shutil.copyfile(commit_path, provenance / "upstream-commit.json")
        shutil.copyfile(tree_path, provenance / "upstream-tree.json")
        manifest = {
            "schemaVersion": 1,
            "upstreamRepository": REPOSITORY,
            "upstreamVersion": "v0.1.1",
            "commit": COMMIT,
            "gitTree": commit["tree"]["sha"],
            "archiveUrl": ARCHIVE_URL,
            "archiveSha256": sha256_file(archive),
            "archiveBytes": archive.stat().st_size,
            "importedAt": datetime.now(timezone.utc).isoformat(),
            "verification": "Every archived tracked blob matched the official recursive Git tree SHA-1 and size; local SHA-256 recorded separately",
            "trackedBlobCount": len(files),
            "trackedBlobBytes": sum(item["bytes"] for item in files),
            "upstreamTrackedFilesModified": False,
            "sourceInventory": f"{PROVENANCE}/files.jsonl",
            "sourceInventorySha256": sha256_file(provenance / "files.jsonl"),
            "license": {
                "identifier": "MIT",
                "path": "LICENSE",
                "sha256": sha256_file(staging / "LICENSE"),
                "copyright": "Copyright (c) 2026 T3 Tools Inc.",
                "notice": "Nested dependencies, reference repositories and assets retain their own licenses; the root MIT license does not replace them.",
            },
            "gitlinks": [{"path": item["path"], "commit": item["sha"], "expanded": False} for item in gitlinks],
            "excludedGeneratedContent": [".git metadata", "untracked node_modules", "untracked build outputs"],
            "notes": [
                "Imported the complete official tracked source archive, including .repos reference source and upstream fixtures; no dependency installation or build was performed.",
                "A small number of upstream tracked test fixtures use node_modules in their paths. They are verified source fixtures, not an installed dependency tree.",
                "Gitlinks are recorded as upstream commit references. Their contents are not included in GitHub source archives and have not been represented as downloaded source.",
                "The .autoops-source directory is AutoOps provenance metadata and is not upstream application code.",
            ],
        }
        write_json(provenance / "manifest.json", manifest)
        staging.rename(destination)
        print(json.dumps({"destination": str(destination), **manifest}, ensure_ascii=False, indent=2))
    except BaseException:
        # Keep failed staging for diagnosis; never delete an existing vendor tree.
        print(f"Import did not complete. Diagnostic staging retained at {staging}")
        raise


def verify_source(args):
    destination = args.destination.resolve()
    provenance = destination / PROVENANCE
    manifest = read_json(provenance / "manifest.json")
    if manifest["commit"] != COMMIT:
        raise ValueError("Unexpected imported commit")
    inventory_path = provenance / "files.jsonl"
    if sha256_file(inventory_path) != manifest["sourceInventorySha256"]:
        raise ValueError("Source inventory was modified")
    files = [json.loads(line) for line in inventory_path.read_text().splitlines()]
    failures, expected, source_directories = [], set(), set()
    for item in files:
        expected.add(item["path"])
        source_directories.update(parent.as_posix() for parent in PurePosixPath(item["path"]).parents)
        path = destination / item["path"]
        try:
            data = os.readlink(path).encode() if item["gitMode"] == "120000" else path.read_bytes()
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"] or blob_hash(data) != item["gitBlobSha1"]:
                failures.append({"path": item["path"], "reason": "local content differs from upstream", "upstreamSha256": item["sha256"], "localSha256": hashlib.sha256(data).hexdigest()})
            elif item["gitMode"] != "120000" and bool(path.stat().st_mode & 0o111) != (item["gitMode"] == "100755"):
                failures.append({"path": item["path"], "reason": "executable mode mismatch"})
        except OSError as error:
            failures.append({"path": item["path"], "reason": str(error)})
    extras, generated_directories = [], []
    for current, directories, names in os.walk(destination, followlinks=False):
        directories[:] = [name for name in directories if not (Path(current) == destination and name == PROVENANCE)]
        for name in list(directories):
            relative = (Path(current) / name).relative_to(destination).as_posix()
            if name in {"node_modules", "dist", "dist-electron", ".vite-plus", ".turbo", "coverage", ".git"} and relative not in source_directories:
                directories.remove(name)
                generated_directories.append(relative)
        # Git's directory symlink is itself a tracked blob.
        names += [name for name in directories if (Path(current) / name).is_symlink()]
        for name in names:
            relative = (Path(current) / name).relative_to(destination).as_posix()
            if relative not in expected:
                extras.append(relative)
    report = {"commit": COMMIT, "baselineInventoryUnchanged": True, "checkedBlobs": len(files), "generatedAt": datetime.now(timezone.utc).isoformat(), "localAdaptations": failures, "extraSourceFiles": extras, "ignoredGeneratedDirectories": generated_directories, "cleanUpstreamBaseline": not (failures or extras)}
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if (failures or extras) and not args.allow_adaptations:
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    importer = subcommands.add_parser("import")
    importer.add_argument("--archive", type=Path, required=True)
    importer.add_argument("--commit-json", type=Path, required=True)
    importer.add_argument("--tree-json", type=Path, required=True)
    importer.add_argument("--destination", type=Path, required=True)
    verifier = subcommands.add_parser("verify")
    verifier.add_argument("--destination", type=Path, required=True)
    verifier.add_argument("--allow-adaptations", action="store_true", help="Report local differences without treating approved adaptation as corruption; never changes source")
    verifier.add_argument("--report", type=Path, help="Write the current adaptation inventory separately from the immutable upstream baseline")
    args = parser.parse_args()
    (import_source if args.command == "import" else verify_source)(args)


if __name__ == "__main__":
    main()
