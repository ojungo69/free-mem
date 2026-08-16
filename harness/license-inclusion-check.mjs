#!/usr/bin/env node
// license / NOTICE / attribution が欠けていないかを検査する。
//
// 目的は「配布物にライセンス表示が載らない」事故の検出であって、ライセンスの妥当性判断ではない。
// 判断は evidence/adr-004-licensing.md 側にある。
//
// usage: node harness/license-inclusion-check.mjs [repoRoot]

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function requireFile(path, why) {
  if (!existsSync(join(root, path))) failures.push(`missing ${path} (${why})`);
}

requireFile("LICENSE", "repository-wide grant");
requireFile("NOTICE", "Apache-2.0 §4(d) attribution");
requireFile("THIRD_PARTY_NOTICES.md", "third-party attribution");
requireFile("CONTRIBUTING.md", "inbound contribution terms");
requireFile("vendor/codemem/LICENSE", "vendored MIT snapshot must keep its own license");

if (failures.length === 0) {
  const license = read("LICENSE");
  if (!/Apache License\s+Version 2\.0/.test(license)) {
    failures.push("LICENSE is not the Apache-2.0 text (README and ADR-004 claim Apache-2.0)");
  }

  const vendorLicense = read("vendor/codemem/LICENSE");
  if (!/MIT License/i.test(vendorLicense)) {
    failures.push("vendor/codemem/LICENSE is no longer the upstream MIT text");
  }

  const readme = read("README.md");
  if (!/Apache License 2\.0/.test(readme)) {
    failures.push("README.md does not state the same license as LICENSE");
  }
  if (!/vendor\/codemem\/.*MIT|MIT snapshot/.test(readme)) {
    failures.push("README.md no longer records that vendor/codemem stays MIT");
  }

  const notice = read("NOTICE");
  if (!/vendor\/codemem/.test(notice)) {
    failures.push("NOTICE no longer points at the vendored snapshot's own license");
  }

  // vendored package は MIT のまま。Apache-2.0 へ書き換えられていないことを確認する
  const pkgDir = join(root, "vendor/codemem/packages");
  const pkgFiles = [join(root, "vendor/codemem/package.json")];
  if (existsSync(pkgDir)) {
    for (const name of readdirSync(pkgDir)) {
      const p = join(pkgDir, name, "package.json");
      if (existsSync(p)) pkgFiles.push(p);
    }
  }
  for (const file of pkgFiles) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    const rel = file.slice(root.length + 1);
    // private workspace package は npm に出ないため license 欄が無くてよい（upstream の状態）。
    // 出るものは MIT を明示していること、出ないものも MIT 以外を名乗っていないことを見る。
    if (pkg.license !== undefined && pkg.license !== "MIT") {
      failures.push(`${rel}: vendored package must stay "MIT", got ${JSON.stringify(pkg.license)}`);
    } else if (pkg.license === undefined && pkg.private !== true) {
      failures.push(`${rel}: publishable vendored package has no license field (expected "MIT")`);
    }
  }
}

if (failures.length > 0) {
  console.error("license inclusion check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("license inclusion check OK");
