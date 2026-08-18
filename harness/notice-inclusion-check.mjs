#!/usr/bin/env node
// build 前提の存在確認では生成停止を見逃すため、自分で build と pack を行い、公開 tarball を検査する。

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NO_BUNDLED_DEPENDENCIES = "No third-party code is bundled in this artifact.";
const ENTRY_MARKER = "<!-- codemem:dependency -->";
const LICENSE_MARKER = "<!-- codemem:license-text -->";
const LICENSE_END_MARKER = "<!-- codemem:end-license-text -->";

const PACKAGES = [
  {
    name: "codemem",
    directory: "packages/cli",
    notices: [
      { path: "dist/THIRD_PARTY_NOTICES.md", empty: true },
      { path: "dist/THIRD_PARTY_NOTICES.hook-runtime.md", dependencies: ["commander"] },
    ],
  },
  {
    name: "@codemem/core",
    directory: "packages/core",
    notices: [{ path: "dist/THIRD_PARTY_NOTICES.md", dependencies: ["hono"] }],
  },
  {
    name: "@codemem/mcp",
    directory: "packages/mcp-server",
    notices: [{ path: "dist/THIRD_PARTY_NOTICES.md", empty: true }],
  },
  {
    name: "@codemem/server",
    directory: "packages/viewer-server",
    notices: [
      { path: "dist/THIRD_PARTY_NOTICES.md", empty: true },
      {
        path: "static/THIRD_PARTY_NOTICES.md",
        dependencies: ["preact", "@radix-ui/react-dialog", "dompurify", "tslib"],
        // 名指しの 4 件だけでは、生成が途中で退行して残りが落ちても通ってしまう。実測 47 件に対する
        // 下限を置いて部分的な欠落も落とす。完全な 47 件を正本として固定しないのは、依存の正当な
        // 増減のたびに CI が落ち、その圧力が「検査を緩める」方向に働くため。
        minEntries: 40,
      },
    ],
  },
  // rollup build を通らない（成果物が git に commit 済み）ため、module graph 由来の notice を
  // 作れない。実測では第三者コードを含まないので検査対象は空だが、「検討して対象外にした」ことを
  // 残すために一覧には置く。詳細は evidence/adr-004-licensing.md。
  { name: "@codemem/opencode-plugin", directory: "packages/opencode-plugin", notices: [] },
];

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(repositoryRoot, "vendor", "codemem");

function licenseBodies(text) {
  const bodies = [];
  let cursor = 0;
  while (true) {
    const start = text.indexOf(LICENSE_MARKER, cursor);
    if (start === -1) break;
    const bodyStart = text.indexOf("\n\n", start + LICENSE_MARKER.length);
    const end = text.indexOf(LICENSE_END_MARKER, start + LICENSE_MARKER.length);
    if (bodyStart === -1 || end === -1 || bodyStart >= end) break;
    bodies.push(text.slice(bodyStart + 2, end).trim());
    cursor = end + LICENSE_END_MARKER.length;
  }
  return bodies;
}

export function inspectPackageDirectory(packageName, packageDirectory) {
  const packageSpec = PACKAGES.find((candidate) => candidate.name === packageName);
  if (!packageSpec) return { failures: [`unknown package ${packageName}`], counts: [] };

  const failures = [];
  const counts = [];
  for (const notice of packageSpec.notices) {
    const noticePath = join(packageDirectory, ...notice.path.split("/"));
    if (!existsSync(noticePath)) {
      failures.push(`${packageName}: missing ${notice.path}`);
      continue;
    }

    const text = readFileSync(noticePath, "utf8");
    if (text.trim() === "") {
      failures.push(`${packageName}: ${notice.path} is empty`);
      continue;
    }

    const entryCount = text.split(ENTRY_MARKER).length - 1;
    const licenseCount = text.split(LICENSE_MARKER).length - 1;
    const bodies = licenseBodies(text);
    counts.push({ packageName, path: notice.path, entries: entryCount });

    if (entryCount !== licenseCount) {
      failures.push(
        `${packageName}: ${notice.path} has ${entryCount} entries but ${licenseCount} license text fields`,
      );
    }
    if (bodies.length !== licenseCount || bodies.some((body) => body === "")) {
      failures.push(`${packageName}: ${notice.path} has a missing or empty license text body`);
    }

    if (notice.minEntries !== undefined && entryCount < notice.minEntries) {
      failures.push(
        `${packageName}: ${notice.path} has ${entryCount} entries, expected at least ${notice.minEntries}`,
      );
    }

    if (notice.empty) {
      if (!text.includes(NO_BUNDLED_DEPENDENCIES)) {
        failures.push(`${packageName}: ${notice.path} does not state that no third-party code is bundled`);
      }
      if (entryCount !== 0) {
        failures.push(`${packageName}: ${notice.path} should have 0 entries, got ${entryCount}`);
      }
    }

    for (const dependency of notice.dependencies ?? []) {
      if (!text.includes(`- Name: \`${dependency}\``)) {
        failures.push(`${packageName}: ${notice.path} is missing bundled dependency ${dependency}`);
      }
    }
  }

  return { failures, counts };
}

function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function pack(packageSpec, temporaryRoot) {
  const packageTemp = join(temporaryRoot, packageSpec.name.replaceAll(/[@/]/g, "_"));
  const tarballDirectory = join(packageTemp, "tarball");
  const extractDirectory = join(packageTemp, "extract");
  mkdirSync(tarballDirectory, { recursive: true });
  mkdirSync(extractDirectory, { recursive: true });

  run(
    "corepack",
    ["pnpm", "pack", "--pack-destination", tarballDirectory],
    join(vendorRoot, packageSpec.directory),
  );
  const tarballs = readdirSync(tarballDirectory).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`${packageSpec.name}: expected one tarball, found ${tarballs.length}`);
  }
  run("tar", ["-xzf", join(tarballDirectory, tarballs[0]), "-C", extractDirectory], repositoryRoot);

  const packageDirectory = join(extractDirectory, "package");
  if (!existsSync(packageDirectory)) throw new Error(`${packageSpec.name}: tarball has no package/ directory`);
  return packageDirectory;
}

function main() {
  const failures = [];
  const counts = [];
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codemem-notices-"));

  try {
    run("corepack", ["pnpm", "install", "--frozen-lockfile"], vendorRoot);

    // build 前に検査対象の notice を消す。viewer-server/static は emptyOutDir: false なので、
    // 生成が止まっても前回のファイルが残り、古い内容をこの検査が受理してしまう——塞ごうとしている
    // fail-open そのものが検査側に生える。消してから build すれば、生成が止まった回は missing で落ちる。
    // clean checkout の CI では起きないが、同じ作業ツリーで繰り返す release preflight では起きる。
    for (const packageSpec of PACKAGES) {
      for (const notice of packageSpec.notices) {
        rmSync(join(vendorRoot, packageSpec.directory, ...notice.path.split("/")), { force: true });
      }
    }

    run("corepack", ["pnpm", "-r", "run", "build"], vendorRoot);

    for (const packageSpec of PACKAGES) {
      if (packageSpec.notices.length === 0) continue;
      const packageDirectory = pack(packageSpec, temporaryRoot);
      const result = inspectPackageDirectory(packageSpec.name, packageDirectory);
      failures.push(...result.failures);
      counts.push(...result.counts);
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  for (const notice of counts) {
    console.log(`${notice.packageName} ${notice.path}: ${notice.entries} entries`);
  }

  if (failures.length > 0) {
    console.error("third-party notice inclusion check FAILED:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("third-party notice inclusion check OK");
}

// 直接起動されたかどうかの判定。両側を realpath に落としてから比べる: `import.meta.url` は Node が
// 実体パスへ正規化するのに対し `process.argv[1]` は起動時の綴りのままなので、symlink を挟んだ経路で
// 起動すると一致せず、main() を呼ばないまま exit 0 で終わる。
//
// `import.meta.main` にも置き換えないこと。あれは Node 24.2 で入ったので、engines の `>=24` を
// 満たす 24.0 / 24.1 では undefined になり、同じく main() を呼ばない。
//
// どちらの取り違えも「検査した」と「検査しなかった」の区別を消す = ゲートとしては fail-open。
export function isDirectInvocation(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) main();
