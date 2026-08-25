import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync,
  realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalizeJson } from "../../../harness/schema/jcs.ts";

function isWithin(base, target) {
  const path = relative(base, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function artifactFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = artifactFiles(root, path);
      if (nested.length === 0) throw new Error(`candidate artifact contains an empty directory: ${path}`);
      return nested;
    }
    if (!entry.isFile()) throw new Error(`candidate artifact contains a non-regular entry: ${path}`);
    return [relative(root, path).split(sep).join("/")];
  }).sort();
}

function hashArtifact(path, candidateRoot) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const openedPath = realpathSync(`/proc/self/fd/${descriptor}`);
    if (!before.isFile() || !isWithin(candidateRoot, openedPath)) {
      throw new Error(`artifact path is not a contained regular file: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((name) => before[name] !== after[name])) {
      throw new Error(`artifact changed while it was being hashed: ${path}`);
    }
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } finally {
    closeSync(descriptor);
  }
}

function validateArtifactFiles(artifactRoot, candidateId, manifest) {
  if (!/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId)) {
    throw new Error("candidate identifier is not a single safe path segment");
  }
  const manifestPaths = manifest.files.map((file) => file.path);
  if (!manifestPaths.every((path, index) => index === 0 || manifestPaths[index - 1] < path)) {
    throw new Error("artifact manifest paths are duplicated or not canonically sorted");
  }
  if (!manifestPaths.includes(manifest.entrypoint)) {
    throw new Error("candidate entrypoint is not present in the artifact manifest");
  }
  const root = realpathSync(resolve(artifactRoot));
  const candidateRoot = realpathSync(resolve(root, candidateId));
  if (!isWithin(root, candidateRoot)) {
    throw new Error("candidate artifact directory escapes the artifact root");
  }
  const actualPaths = artifactFiles(candidateRoot);
  if (actualPaths.length !== manifestPaths.length ||
      actualPaths.some((path, index) => path !== manifestPaths[index])) {
    throw new Error("candidate artifact files do not exactly match the manifest");
  }
  for (const file of manifest.files) {
    const path = realpathSync(resolve(candidateRoot, file.path));
    if (!isWithin(candidateRoot, path)) throw new Error(`artifact path escapes root: ${file.path}`);
    const digest = hashArtifact(path, candidateRoot);
    if (digest !== file.sha256) {
      throw new Error(`artifact bytes do not match manifest digest: ${file.path}`);
    }
  }
}

export function validateArtifact(result, artifactRoot, baseCommit) {
  const metadata = result.artifactMetadata;
  const fingerprint = (domain, value) => `sha256:${createHash("sha256")
    .update(domain).update(canonicalizeJson(value)).digest("hex")}`;
  if (metadata.candidateId !== result.candidateId || metadata.baseCommit !== baseCommit ||
      metadata.contentSha256 !== fingerprint(
        "free-mem:alpha-artifact-content:v1\0", metadata.manifest,
      ) || result.artifactFingerprint !== fingerprint(
        "free-mem:alpha-candidate-artifact:v1\0", metadata,
      )) {
    throw new Error("candidate artifact identity does not match its manifest");
  }
  validateArtifactFiles(artifactRoot, result.candidateId, metadata.manifest);
}
