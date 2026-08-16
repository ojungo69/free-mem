import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeJson, decodeUtf8, parseIJson } from "../schema/jcs.ts";

/**
 * JCS そのものを実装している以上、「JCS になっている」ことを見る test が要る。
 * RFC 8785 の本文と付録から、この harness が扱う部分集合に効く性質を取っている。
 */

test("object のキーは UTF-16 code unit の昇順で並ぶ（RFC 8785 §3.2.3）", () => {
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  // 大文字は小文字より前（ASCII の順序であって辞書順ではない）
  assert.equal(canonicalizeJson({ a: 1, B: 2 }), '{"B":2,"a":1}');
  // 非 ASCII も code unit 順。a(0x61) < é(0xE9) < ċ(0x10B) < €(0x20AC)
  assert.equal(
    canonicalizeJson({ "€": 1, "é": 2, a: 3, "ċ": 4 }),
    '{"a":3,"é":2,"ċ":4,"€":1}',
  );
  // ここが JCS の肝。**code point 順ではなく UTF-16 code unit 順**なので、
  // 代理対（U+10384 = 0xD800,0xDF84）は U+FB33 より前に来る。code point 順に
  // 並べる実装とはここで bytes が食い違う（RFC 8785 §3.2.3）
  assert.equal(
    canonicalizeJson({ "\u{10384}": 1, "\uFB33": 2 }),
    '{"\u{10384}":1,"\uFB33":2}',
  );
  // 入れ子も同じ規則
  assert.equal(canonicalizeJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test("配列の順序は保持する（並べ替えは値の側の責任）", () => {
  assert.equal(canonicalizeJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalizeJson({ a: [{ b: 1, a: 2 }] }), '{"a":[{"a":2,"b":1}]}');
});

test("空白を入れず、文字列と数値は ECMAScript の表記に従う", () => {
  assert.equal(canonicalizeJson({ a: 1, b: [1, 2] }), '{"a":1,"b":[1,2]}');
  assert.equal(canonicalizeJson("a\nb"), '"a\\nb"');
  assert.equal(canonicalizeJson("é"), '"é"'); // 非 ASCII はエスケープしない
  assert.equal(canonicalizeJson(1e21), "1e+21");
  assert.equal(canonicalizeJson(0.1), "0.1");
  assert.equal(canonicalizeJson(-0), "0"); // JCS は -0 を 0 として出す
  assert.equal(canonicalizeJson(null), "null");
  assert.equal(canonicalizeJson(true), "true");
});

test("JSON に無い値は受け付けない", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
    assert.throws(() => canonicalizeJson(bad), /非有限/);
  }
  assert.throws(() => canonicalizeJson(() => 1), /JSON に無い型/);
  assert.throws(() => canonicalizeJson(1n), /JSON に無い型/);
  // undefined の property は落とさない。落とすと `{ a: 1 }` と同じ hash になり、
  // 組み立て損ねた契約値が「その欄は元々無かった」ものとして通る
  assert.equal(JSON.stringify({ a: 1, b: undefined }), '{"a":1}');
  assert.throws(() => canonicalizeJson({ a: 1, b: undefined }), /JSON に無い型/);
});

test("対になっていない代理は拒否する（RFC 8785 §3.2.2.2）", () => {
  // `JSON.stringify` は well-formed 化してエスケープを返すだけなので、そのままだと
  // 「TS では hash が出るが、準拠した実装は計算を拒否する」状態になる
  assert.equal(JSON.stringify("\ud800"), '"\\ud800"');
  for (const bad of ["\ud800", "a\udfff", "\ud800a", "\udc00\ud800"]) {
    assert.throws(() => canonicalizeJson(bad), /代理/, JSON.stringify(bad));
    assert.throws(() => canonicalizeJson({ [bad]: 1 }), /代理/, `key ${JSON.stringify(bad)}`);
    assert.throws(() => canonicalizeJson({ a: [bad] }), /代理/, `nested ${JSON.stringify(bad)}`);
  }
  // 正しい代理対は通る
  assert.equal(canonicalizeJson("\u{10384}"), '"\u{10384}"');
  assert.equal(canonicalizeJson({ "\u{10384}": 1 }), '{"\u{10384}":1}');
});

test("キー順が違うだけの object は同じ bytes になる", () => {
  const a = { x: 1, y: { p: 1, q: 2 }, z: [1, 2] };
  const b = { z: [1, 2], y: { q: 2, p: 1 }, x: 1 };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  // 配列の順序が違えば別物
  assert.notEqual(canonicalizeJson({ z: [1, 2] }), canonicalizeJson({ z: [2, 1] }));
});

test("重複した property 名を持つ JSON は読まない（RFC 8785 §3.1 / RFC 7493 §2.3）", () => {
  // `JSON.parse` は後勝ちで潰すだけ。潰れた値は canonicalize できてしまう
  assert.deepEqual(JSON.parse('{"a":1,"a":2}'), { a: 2 });

  for (const bad of [
    '{"a":1,"a":2}',
    '{"a":{"k":1,"k":2}}',
    '{"a":[{"k":1,"k":2}]}',
    '{"a":[1,{"b":[{"k":{},"k":[]}]}]}',
    '{"\u0061b":1,"ab":2}', // エスケープ違いでも同じ property 名
  ]) {
    assert.throws(() => parseIJson(bad), /property 名が重複/, bad);
  }
});

test("重複していない JSON はそのまま読める", () => {
  assert.deepEqual(parseIJson('{"a":1,"b":2}'), { a: 1, b: 2 });
  // 別々の object に同じ名前が出るのは重複ではない
  assert.deepEqual(parseIJson('{"a":{"k":1},"b":{"k":2}}'), { a: { k: 1 }, b: { k: 2 } });
  assert.deepEqual(parseIJson('[{"k":1},{"k":2}]'), [{ k: 1 }, { k: 2 }]);
  // 値の側の文字列は property 名ではない。`"` や `{` を含んでも誤検出しない
  assert.deepEqual(parseIJson('{"a":"\\"k\\":1,\\"k\\":2","k":3}'), { a: '"k":1,"k":2', k: 3 });
  assert.deepEqual(parseIJson('{"a":"}{[,","b":"\\\\"}'), { a: "}{[,", b: "\\" });
  // 整形されていても位置を見失わない
  assert.deepEqual(parseIJson('{\n  "a" : 1,\n  "b" : [ 1, 2 ]\n}'), { a: 1, b: [1, 2] });
  assert.throws(() => parseIJson('{\n  "a" : 1,\n  "a" : 2\n}'), /property 名が重複/);
});

test("疎な配列は canonicalize しない（穴は JSON に無い）", () => {
  // `map` は穴を飛ばすので `[,]` のような JSON でない bytes が出る。`JSON.stringify` は
  // 穴を null にするが、JCS の入力として渡された時点で値が確定していないので落とす
  assert.equal(JSON.stringify(Array(2)), "[null,null]");
  assert.throws(() => canonicalizeJson(Array(2)), /穴のある配列/);
  assert.throws(() => canonicalizeJson([1, , 3]), /穴のある配列/);
  assert.throws(() => canonicalizeJson({ a: [1, , 3] }), /穴のある配列/);
  // 穴でない undefined は配列でも同じ扱い
  assert.throws(() => canonicalizeJson([undefined]), /JSON に無い型/);
});

test("添字以外の property を持つ配列は canonicalize しない", () => {
  const tagged: unknown[] & { metadata?: string } = [1];
  tagged.metadata = "lost";
  assert.equal(JSON.stringify(tagged), "[1]"); // 付けた欄は消える
  assert.throws(() => canonicalizeJson(tagged), /length 以外の own key/);
  const symbolTagged = [1];
  (symbolTagged as unknown as Record<symbol, number>)[Symbol("s")] = 1;
  assert.throws(() => canonicalizeJson(symbolTagged), /length 以外の own key/);

  // 件数だけ数えると、穴が空けた枠に別の key が収まって素通りする。しかも `Array.from` は
  // 差し替えられた `Symbol.iterator` を呼ぶので、実在しない要素の bytes まで出せる
  const forged = Array(1);
  (forged as unknown as Record<symbol, unknown>)[Symbol.iterator] = function* () {
    yield 7;
  };
  assert.throws(() => canonicalizeJson(forged), /length 以外の own key/);

  assert.equal(canonicalizeJson([1, 2]), "[1,2]");
});

test("I-JSON は代理と noncharacter を文字列に許さない（RFC 7493 §2.1）", () => {
  // `JSON.parse` はどちらも通す
  assert.deepEqual(JSON.parse('{"a":"\uDEAD"}'), { a: "\uDEAD" });

  for (const bad of [
    '{"a":"\uD800"}',
    '{"a":["\uDEAD"]}',
    '{"\uDEAD":1}',
    '["a\uDC00"]',
  ]) {
    assert.throws(() => parseIJson(bad), /対になっていない代理/, bad);
  }

  // noncharacter も I-JSON では不正（面ごとの FFFE/FFFF と FDD0-FDEF）
  for (const bad of [
    '{"a":"\uFFFE"}',
    '{"a":"\uFFFF"}',
    '{"a":"\uFDD0"}',
    '{"\uFFFE":1}',
    '{"a":"\uDBFF\uDFFF"}', // U+10FFFF（代理対としては正しいが noncharacter）
  ]) {
    assert.throws(() => parseIJson(bad), /noncharacter/, bad);
  }

  // 正しい代理対は通る（RFC 7493 §2.1 が legal と書いている例そのもの）
  assert.deepEqual(parseIJson('{"a":"\uD800\uDEAD"}'), { a: "\uD800\uDEAD" });
});

test("binary64 で表せない数を含む JSON は読まない（RFC 7493 §2.2）", () => {
  // `JSON.parse` は範囲外の数を Infinity にする。そこから先は比較も hash も意味を失う
  assert.equal(JSON.parse('{"a":1e400}').a, Number.POSITIVE_INFINITY);

  for (const bad of ['{"a":1e400}', '{"a":-1e400}', '{"a":[1e400]}', '{"a":{"b":1e400}}']) {
    assert.throws(() => parseIJson(bad), /binary64 で表せない/, bad);
  }
  // 表せる範囲はそのまま通る
  assert.deepEqual(parseIJson('{"a":1e308,"b":-0,"c":0.1}'), { a: 1e308, b: -0, c: 0.1 });
});

test("素の object でない値は canonicalize しない", () => {
  // enumerable な own property が無いので、通すと値と無関係な `{}` の bytes が出る
  assert.equal(JSON.stringify(new Map([["x", 1]])), "{}");
  for (const bad of [new Map([["x", 1]]), new Set([1]), new Date(0), Object(1), Object("a")]) {
    assert.throws(() => canonicalizeJson(bad), /素の object でない/, String(bad));
  }
  class Capsule {
    id = "x";
  }
  assert.throws(() => canonicalizeJson(new Capsule()), /できない: Capsule/);
  assert.throws(() => canonicalizeJson({ a: new Date(0) }), /素の object でない/);
  // `Object.entries` が飛ばす own property を持つ object も落とす（`{}` として hash されるため）
  assert.equal(JSON.stringify(Object.defineProperty({}, "x", { value: 1 })), "{}");
  assert.throws(
    () => canonicalizeJson(Object.defineProperty({}, "x", { value: 1 })),
    /非 enumerable/,
  );
  assert.throws(() => canonicalizeJson({ [Symbol("s")]: 1 }), /symbol キー/);

  // `{}` と `Object.create(null)` 由来は通る（JSON.parse が返すのはこの 2 つ）
  assert.equal(canonicalizeJson({ a: 1 }), '{"a":1}');
  assert.equal(canonicalizeJson(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');
});

test("UTF-8 として不正な bytes は置換せずに落とす（RFC 7493 §2.1）", () => {
  // `Buffer.toString("utf8")` / TextDecoder の既定は不正 byte を U+FFFD に置換する。
  // 置換された値から hash を出すと、元の bytes を拒否する実装と食い違う
  const broken = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]); // {"a":"\xff"}
  assert.equal(Buffer.from(broken).toString("utf8"), '{"a":"\ufffd"}');
  assert.throws(() => decodeUtf8(broken, "t.json"), /UTF-8 として不正/);
  // 正しい UTF-8 はそのまま
  assert.equal(decodeUtf8(new TextEncoder().encode('{"a":"é"}'), "t.json"), '{"a":"é"}');
});
