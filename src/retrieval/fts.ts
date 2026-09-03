// Lexical query routing for FTS5 trigram + CJK bigram (research.md R5, FR-025).

const CJK_CHAR =
  /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|[ー々・\uFF70\uFF65])$/u;

const PARTICLES = new Set(['は', 'が', 'を', 'に', 'で', 'と', 'の', 'も', 'へ', 'や', 'か', 'ね', 'よ', 'な']);

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

export function isCjk(char: string): boolean {
  return CJK_CHAR.test(char);
}

export function cjkBigrams(text: string): string {
  const terms: string[] = [];
  let run = '';
  const flush = (): void => {
    const chars = [...run];
    if (chars.length === 1) {
      terms.push(run);
    } else if (chars.length >= 2) {
      for (let i = 0; i + 1 < chars.length; i++) {
        terms.push(chars[i] + chars[i + 1]);
      }
    }
    run = '';
  };
  for (const char of text) {
    if (isCjk(char)) run += char;
    else flush();
  }
  flush();
  return terms.join(' ');
}

export type QueryTerms = {
  trigram: string[];
  cjk: string[];
  like: string[];
};

function codePointLength(text: string): number {
  return [...text].length;
}

function isAllCjk(text: string): boolean {
  if (text.length === 0) return false;
  for (const char of text) {
    if (!isCjk(char)) return false;
  }
  return true;
}

function isAllNonCjk(text: string): boolean {
  for (const char of text) {
    if (isCjk(char)) return false;
  }
  return true;
}

function splitByScript(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let bufCjk: boolean | undefined;
  for (const char of text) {
    const cjk = isCjk(char);
    if (buf.length === 0 || cjk === bufCjk) {
      buf += char;
      bufCjk = cjk;
    } else {
      parts.push(buf);
      buf = char;
      bufCjk = cjk;
    }
  }
  if (buf.length > 0) parts.push(buf);
  return parts;
}

function pushUnique(terms: string[], term: string): void {
  if (!terms.includes(term)) terms.push(term);
}

export function segmentQuery(text: string): QueryTerms {
  const trigram: string[] = [];
  const cjk: string[] = [];
  const like: string[] = [];

  for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike) continue;
    const pieces =
      isAllCjk(segment) || isAllNonCjk(segment) ? [segment] : splitByScript(segment);
    for (const piece of pieces) {
      if (piece.length === 0) continue;
      if (isAllCjk(piece)) {
        if (codePointLength(piece) === 1 && PARTICLES.has(piece)) continue;
        for (const term of cjkBigrams(piece).split(' ')) {
          if (term.length > 0) pushUnique(cjk, term);
        }
        continue;
      }
      const lower = piece.toLowerCase();
      const length = codePointLength(lower);
      if (length >= 3) pushUnique(trigram, lower);
      else if (length >= 1) pushUnique(like, lower);
    }
  }

  return { trigram, cjk, like };
}

export function buildMatch(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}
