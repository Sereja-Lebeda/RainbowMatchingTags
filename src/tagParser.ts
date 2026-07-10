/**
 * Pure, VS Code-independent tag parsing and matching.
 *
 * Operates on plain string offsets so it can be unit tested without spinning
 * up the editor. `extension.ts` converts these offsets to vscode.Range.
 *
 * Design notes (why this differs from the original extension it fixes):
 * The original implementation matched closing tags by blindly popping
 * whatever was last pushed onto a stack, and picked colors from a global
 * counter that only ever increased. A single missing or commented-out tag
 * left a phantom entry on the stack (or never advanced/reset the counter
 * correctly), which desynced the color of every tag pair after it in the
 * document. This version matches closing tags by searching the stack for
 * the nearest entry with the same tag name (like a browser's implicit-close
 * recovery) and colors purely by nesting depth captured at push time, so an
 * unmatched tag only orphans itself and its true descendants instead of
 * corrupting unrelated pairs elsewhere in the file.
 */

export interface OffsetRange {
  start: number;
  end: number;
}

export interface ParsedTag {
  name: string;
  isClosing: boolean;
  /** Range of the whole tag, e.g. `<div class="a">` or `</div>`. */
  full: OffsetRange;
  /** Range to actually paint: `<name` for openings, the whole tag for closings. */
  nameRange: OffsetRange;
  /** For openings with attributes, the range of the trailing `>` so it gets painted too. Null for closing tags. */
  closeBracketRange: OffsetRange | null;
}

export interface TagPair {
  open: ParsedTag;
  close: ParsedTag;
  depth: number;
}

export interface ParseResult {
  pairs: TagPair[];
  /** Orphan closing tags, and opening tags that were never (yet) closed. */
  unmatched: ParsedTag[];
}

const TAG_HEAD_PATTERN = /<(\/)?([a-zA-Z][-a-zA-Z0-9:_.]*)/g;
const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

interface AttrScanResult {
  /** Offset just past the tag's closing ">" (or the trailing "/>"). */
  end: number;
  selfClosing: boolean;
}

/**
 * Scans attribute content starting right after the tag name, tracking quote
 * state and `{}` nesting depth so a bare `>` inside a JS expression - an
 * arrow function (`() => x`), a comparison (`a > b`), a ternary, or a nested
 * JSX element passed as a prop (`icon={<Foo />}`) - is never mistaken for
 * the tag's closing bracket. The tag only actually ends at a `>` (or `/>`)
 * seen while brace depth is 0 and we're not inside a quoted string.
 */
function scanTagAttrs(text: string, start: number): AttrScanResult | null {
  let braceDepth = 0;
  let quote: string | null = null;
  const len = text.length;

  for (let i = start; i < len; i++) {
    const ch = text[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      continue;
    }
    if (ch === '}') {
      if (braceDepth > 0) {
        braceDepth--;
      }
      continue;
    }

    if (braceDepth === 0) {
      if (ch === '/' && text[i + 1] === '>') {
        return { end: i + 2, selfClosing: true };
      }
      if (ch === '>') {
        return { end: i + 1, selfClosing: false };
      }
    }
  }

  return null;
}

/** Replaces every non-newline character with a space, preserving string length and line breaks. */
function blank(s: string): string {
  return s.replace(/[^\r\n]/g, ' ');
}

/**
 * Blanks out HTML/XML comments (`<!-- ... -->`) so tags inside them are never
 * matched, while keeping the string the same length (so offsets stay valid).
 * An unterminated comment blanks out the rest of the document, matching how
 * a real parser would treat it.
 */
export function blankOutComments(text: string): string {
  let result = '';
  let i = 0;
  const len = text.length;
  while (i < len) {
    const start = text.indexOf('<!--', i);
    if (start === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, start);
    const closeIdx = text.indexOf('-->', start + 4);
    const end = closeIdx === -1 ? len : closeIdx + 3;
    result += blank(text.slice(start, end));
    i = end;
  }
  return result;
}

/**
 * Scans the text for tag-like tokens, skipping comments, raw-text element
 * content (script/style), self-closing tags, and denylisted tag names.
 */
export function extractTags(text: string, denylist: ReadonlySet<string>): ParsedTag[] {
  const cleaned = blankOutComments(text);
  const tags: ParsedTag[] = [];
  const headRe = new RegExp(TAG_HEAD_PATTERN);

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(cleaned))) {
    const isClosing = m[1] === '/';
    const name = m[2];
    const start = m.index;
    const lowerName = name.toLowerCase();

    const scan = scanTagAttrs(cleaned, headRe.lastIndex);
    if (!scan) {
      // Unterminated tag (e.g. a stray "<" that isn't really a tag at all).
      // Don't let it swallow the rest of the document - just skip past the
      // "<" and keep looking for real tags.
      headRe.lastIndex = start + 1;
      continue;
    }

    const end = scan.end;
    headRe.lastIndex = end;

    if (!isClosing && !scan.selfClosing && RAW_TEXT_ELEMENTS.has(lowerName)) {
      // Skip raw-text content (script/style) so `<`/`>` operators or
      // comparisons inside it are never mistaken for tags.
      const closeRe = new RegExp('<\\/' + lowerName + '\\s*>', 'i');
      const rest = cleaned.slice(end);
      const closeMatch = closeRe.exec(rest);
      headRe.lastIndex = closeMatch ? end + closeMatch.index : cleaned.length;
    }

    if (scan.selfClosing || denylist.has(lowerName)) {
      continue;
    }

    if (isClosing) {
      tags.push({
        name,
        isClosing: true,
        full: { start, end },
        nameRange: { start, end },
        closeBracketRange: null
      });
    } else {
      const nameEnd = start + 1 + name.length; // end of "<name"
      tags.push({
        name,
        isClosing: false,
        full: { start, end },
        nameRange: { start, end: nameEnd },
        closeBracketRange: { start: end - 1, end }
      });
    }
  }

  return tags;
}

interface StackEntry {
  tag: ParsedTag;
  depth: number;
}

/**
 * Matches an ordered list of tags into pairs. A closing tag is matched
 * against the nearest same-named entry anywhere in the stack (not just the
 * top), so one missing/commented tag only orphans itself and whatever is
 * nested strictly inside it - it cannot desync pairs that come after it.
 */
export function matchTags(tags: ParsedTag[]): ParseResult {
  const stack: StackEntry[] = [];
  const pairs: TagPair[] = [];
  const unmatched: ParsedTag[] = [];

  for (const tag of tags) {
    if (!tag.isClosing) {
      stack.push({ tag, depth: stack.length });
      continue;
    }

    const lowerName = tag.name.toLowerCase();
    let matchIndex = -1;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].tag.name.toLowerCase() === lowerName) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      unmatched.push(tag);
      continue;
    }

    for (let i = stack.length - 1; i > matchIndex; i--) {
      unmatched.push(stack[i].tag);
    }
    const matched = stack[matchIndex];
    stack.length = matchIndex;
    pairs.push({ open: matched.tag, close: tag, depth: matched.depth });
  }

  for (const entry of stack) {
    unmatched.push(entry.tag);
  }

  return { pairs, unmatched };
}

export function parseDocument(text: string, denylist: ReadonlySet<string>): ParseResult {
  return matchTags(extractTags(text, denylist));
}

export interface MatchLookup {
  tag: ParsedTag;
  partner: ParsedTag | null;
}

/** Finds the tag (if any) whose full range contains `offset`, plus its matching partner. */
export function findTagAtOffset(result: ParseResult, offset: number): MatchLookup | null {
  for (const pair of result.pairs) {
    if (offset >= pair.open.full.start && offset <= pair.open.full.end) {
      return { tag: pair.open, partner: pair.close };
    }
    if (offset >= pair.close.full.start && offset <= pair.close.full.end) {
      return { tag: pair.close, partner: pair.open };
    }
  }
  for (const tag of result.unmatched) {
    if (offset >= tag.full.start && offset <= tag.full.end) {
      return { tag, partner: null };
    }
  }
  return null;
}
