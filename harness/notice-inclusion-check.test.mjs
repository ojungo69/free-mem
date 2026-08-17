import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectPackageDirectory } from "./notice-inclusion-check.mjs";

function notice(dependencies) {
  if (dependencies.length === 0) {
    return "# Third-party notices\n\nNo third-party code is bundled in this artifact.\n";
  }
  const entries = dependencies.map(
    (dependency) => `<!-- codemem:dependency -->
## ${dependency}@1.0.0

- Name: \`${dependency}\`
- Version: \`1.0.0\`
- License: \`MIT\`

<!-- codemem:license-text -->
### License text

License for ${dependency}
<!-- codemem:end-license-text -->`,
  );
  return `# Third-party notices\n\n${entries.join("\n\n---\n\n")}\n`;
}

function writeNotice(packageDirectory, path, dependencies) {
  const file = join(packageDirectory, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, notice(dependencies));
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "notice-inclusion-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packages = {
    codemem: join(root, "codemem"),
    "@codemem/core": join(root, "core"),
    "@codemem/mcp": join(root, "mcp"),
    "@codemem/server": join(root, "server"),
  };

  writeNotice(packages.codemem, "dist/THIRD_PARTY_NOTICES.md", []);
  writeNotice(packages.codemem, "dist/THIRD_PARTY_NOTICES.hook-runtime.md", ["commander"]);
  writeNotice(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md", ["hono"]);
  writeNotice(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md", []);
  writeNotice(packages["@codemem/server"], "dist/THIRD_PARTY_NOTICES.md", []);
  writeNotice(packages["@codemem/server"], "static/THIRD_PARTY_NOTICES.md", [
    "preact",
    "@radix-ui/react-dialog",
    "dompurify",
    "tslib",
  ]);
  return packages;
}

function inspectAll(packages) {
  return Object.entries(packages).flatMap(([name, directory]) =>
    inspectPackageDirectory(name, directory).failures,
  );
}

test("正常な notice 一式を受理する", (t) => {
  assert.deepEqual(inspectAll(fixture(t)), []);
});

test("notice ファイルが無ければ拒否する", (t) => {
  const packages = fixture(t);
  unlinkSync(join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md"));
  assert.ok(inspectAll(packages).some((failure) => failure.includes("missing dist/THIRD_PARTY_NOTICES.md")));
});

test("空の notice を拒否する", (t) => {
  const packages = fixture(t);
  writeFileSync(join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md"), "");
  assert.ok(inspectAll(packages).some((failure) => failure.includes("is empty")));
});

test("server notice から preact が欠ければ拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages["@codemem/server"], "static/THIRD_PARTY_NOTICES.md", [
    "@radix-ui/react-dialog",
    "dompurify",
    "tslib",
  ]);
  assert.ok(inspectAll(packages).some((failure) => failure.endsWith("missing bundled dependency preact")));
});

test("server notice から tslib の name 行だけ欠ければ拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/server"], "static/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("- Name: `tslib`", "- Name: `removed`"));
  assert.ok(inspectAll(packages).some((failure) => failure.endsWith("missing bundled dependency tslib")));
});

test("entry に license 本文欄が無ければ拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("<!-- codemem:license-text -->", ""));
  assert.ok(inspectAll(packages).some((failure) => failure.includes("entries but 0 license text fields")));
});

test("0 件 package でも notice ファイルが無ければ拒否する", (t) => {
  const packages = fixture(t);
  unlinkSync(join(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md"));
  assert.ok(inspectAll(packages).some((failure) => failure.startsWith("@codemem/mcp: missing")));
});

// 以下 3 件は「0 件だと宣言している側」の分岐。ここが効いていないと、生成が壊れて中身が
// 別物になった notice を 0 件として通してしまう（ファイルが空でさえなければ素通りする）。

test("0 件 package の notice が 0 件である旨を述べていなければ拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, "# Third-party notices\n\n以前の内容が消えた\n");
  assert.ok(
    inspectAll(packages).some((failure) =>
      failure.includes("does not state that no third-party code is bundled"),
    ),
  );
});

test("0 件のはずの package に entry が現れたら拒否する", (t) => {
  const packages = fixture(t);
  writeNotice(packages["@codemem/mcp"], "dist/THIRD_PARTY_NOTICES.md", ["hono"]);
  assert.ok(inspectAll(packages).some((failure) => failure.includes("should have 0 entries, got 1")));
});

test("license 本文欄はあるが中身が空なら拒否する", (t) => {
  const packages = fixture(t);
  const file = join(packages["@codemem/core"], "dist/THIRD_PARTY_NOTICES.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("License for hono\n", ""));
  assert.ok(
    inspectAll(packages).some((failure) => failure.includes("missing or empty license text body")),
  );
});
