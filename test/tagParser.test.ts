import * as assert from 'assert';
import { extractTags, matchTags, parseDocument, findTagAtOffset, ParsedTag } from '../src/tagParser';

const DENYLIST = new Set([
  '!doctype', 'html', 'head', 'meta', 'body', 'title', 'link', 'script',
  'base', 'style', 'area', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'param', 'source', 'track', 'wbr'
]);

function names(tags: ParsedTag[]): string[] {
  return tags.map(t => (t.isClosing ? '/' : '') + t.name);
}

describe('extractTags', () => {
  it('finds simple nested tags', () => {
    const tags = extractTags('<div><span></span></div>', DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', 'span', '/span', '/div']);
  });

  it('ignores denylisted tags entirely', () => {
    const tags = extractTags('<html><body><div></div></body></html>', DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('ignores self-closing tags', () => {
    const tags = extractTags('<div><img src="x.png"/><CustomIcon/></div>', DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('ignores php and ejs pseudo-tags', () => {
    const tags = extractTags('<div><?php echo $x; ?><%= y %></div>', DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('handles attribute values containing ">"', () => {
    const text = `<div data-value="1>2" class='a>b'><span></span></div>`;
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', 'span', '/span', '/div']);
  });

  it('handles multi-line opening tags', () => {
    const text = '<div\n  class="foo"\n  id="bar"\n>\n  <span></span>\n</div>';
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', 'span', '/span', '/div']);
  });

  it('does not see tags inside a fully commented-out block', () => {
    const text = '<div><!-- <span></span> --></div>';
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('treats an unterminated comment as running to end of file, orphaning what precedes it', () => {
    const text = '<div><!-- <span></span></div>';
    // Everything from "<!--" onward (including the literal "</div>" text)
    // is swallowed by the runaway comment, so only the opening <div> survives.
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div']);
  });

  it('ignores comparison-operator-like content inside <script>', () => {
    const text = '<div><script>if (a < b && c > d) { x(); }</script><span></span></div>';
    const tags = extractTags(text, DENYLIST);
    // script/style are denylisted by default, but the important part is
    // that their raw content never produces bogus tag tokens.
    assert.deepStrictEqual(names(tags), ['div', 'span', '/span', '/div']);
  });

  it('still tokenizes script/style tags themselves when not denylisted', () => {
    const emptyDenylist = new Set<string>();
    const text = '<script>if (a < b) {}</script>';
    const tags = extractTags(text, emptyDenylist);
    assert.deepStrictEqual(names(tags), ['script', '/script']);
  });

  it('still recognizes a self-closing tag whose prop is an arrow function (">" inside "=>")', () => {
    // Regression: the ">" inside "=>" used to be mistaken for the tag's own
    // closing bracket, truncating the tag early and leaving it unmatched.
    const text = '<div><FunctionBtn onClick={() => console.log("hi")} disabled={false} /></div>';
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('still recognizes a self-closing tag whose prop contains a bare ">" comparison', () => {
    const text = '<div><Foo bar={a > b} /></div>';
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('does not let a nested JSX element passed as a prop value close the outer tag early', () => {
    const text = '<div><Foo icon={<Bar />} label="x" /></div>';
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });

  it('handles a real multi-prop self-closing component with an arrow-function onClick, unchanged by siblings', () => {
    const text = [
      '<div>',
      '<FunctionBtn',
      '  Icon={TelegramIcon}',
      '  text="send"',
      '  onClick={() => console.log("TODO: send message")}',
      '  disabled={false}',
      '/>',
      '<FunctionBtn',
      '  Icon={RepeatIcon}',
      '  onClick={onRepeat}',
      '  disabled={false}',
      '/>',
      '</div>'
    ].join('\n');
    const tags = extractTags(text, DENYLIST);
    assert.deepStrictEqual(names(tags), ['div', '/div']);
  });
});

describe('matchTags - robustness against missing/commented tags (the original bug)', () => {
  it('pairs simple siblings at the same depth', () => {
    const tags = extractTags('<div><span></span><p></p></div>', DENYLIST);
    const { pairs, unmatched } = matchTags(tags);
    assert.strictEqual(unmatched.length, 0);
    assert.strictEqual(pairs.length, 3);
    const byName = Object.fromEntries(pairs.map(p => [p.open.name, p.depth]));
    assert.strictEqual(byName['div'], 0);
    assert.strictEqual(byName['span'], 1);
    assert.strictEqual(byName['p'], 1); // sibling of span -> same depth
  });

  it('a partially-commented closing tag only orphans its own opener, not later siblings', () => {
    // <span>'s closing tag is commented out. Everything after must still
    // pair up correctly and keep depth-consistent colors.
    const text = '<section><div><!-- </div> --></section><footer></footer>';
    const result = parseDocument(text, DENYLIST);

    const sectionPair = result.pairs.find(p => p.open.name === 'section');
    const footerPair = result.pairs.find(p => p.open.name === 'footer');
    const divUnmatched = result.unmatched.find(t => t.name === 'div');

    assert.ok(sectionPair, 'section should still be matched');
    assert.ok(footerPair, 'footer must not be corrupted by the earlier unclosed div');
    assert.ok(divUnmatched, 'div should be reported as unmatched (its close was commented out)');
    assert.strictEqual(divUnmatched!.isClosing, false);

    // section and footer are both top-level siblings -> same depth -> same color slot.
    assert.strictEqual(sectionPair!.depth, 0);
    assert.strictEqual(footerPair!.depth, 0);
  });

  it('a missing closing tag entirely (typo/omission) does not desync later pairs', () => {
    const text = '<ul><li>one<li>two</li></ul><footer></footer>';
    // First <li> is never closed (common when people forget </li> on <li> lists).
    const result = parseDocument(text, DENYLIST);

    const ulPair = result.pairs.find(p => p.open.name === 'ul');
    const footerPair = result.pairs.find(p => p.open.name === 'footer');
    const liPairs = result.pairs.filter(p => p.open.name === 'li');
    const orphanLi = result.unmatched.find(t => t.name === 'li');

    assert.ok(ulPair);
    assert.ok(footerPair);
    assert.strictEqual(liPairs.length, 1, 'only the second <li> has an explicit close');
    assert.ok(orphanLi, 'the first <li> should be flagged unmatched');
    assert.strictEqual(ulPair!.depth, footerPair!.depth, 'ul and footer are siblings and must share depth/color');
  });

  it('an unclosed tag until EOF is reported unmatched without breaking earlier pairs', () => {
    const text = '<header></header><div><span>a</span><p>b</p>';
    const result = parseDocument(text, DENYLIST);

    const headerPair = result.pairs.find(p => p.open.name === 'header');
    const spanPair = result.pairs.find(p => p.open.name === 'span');
    const pPair = result.pairs.find(p => p.open.name === 'p');
    const divUnmatched = result.unmatched.find(t => t.name === 'div');

    assert.ok(headerPair);
    assert.ok(spanPair);
    assert.ok(pPair);
    assert.ok(divUnmatched);
    assert.strictEqual(spanPair!.depth, pPair!.depth, 'span and p are siblings inside the unclosed div');
  });

  it('an orphan closing tag (no opener anywhere) is reported unmatched and does not touch the stack', () => {
    const text = '<div></p><span></span></div>';
    const result = parseDocument(text, DENYLIST);

    const orphanClose = result.unmatched.find(t => t.name === 'p');
    const divPair = result.pairs.find(p => p.open.name === 'div');
    const spanPair = result.pairs.find(p => p.open.name === 'span');

    assert.ok(orphanClose);
    assert.strictEqual(orphanClose!.isClosing, true);
    assert.ok(divPair);
    assert.ok(spanPair);
    assert.strictEqual(spanPair!.depth, 1);
    assert.strictEqual(divPair!.depth, 0);
  });

  it('mismatched close implicitly closes intermediate unclosed tags (browser-like recovery)', () => {
    const text = '<section><div><span></section>';
    const result = parseDocument(text, DENYLIST);

    const sectionPair = result.pairs.find(p => p.open.name === 'section');
    const orphanDiv = result.unmatched.find(t => t.name === 'div' && !t.isClosing);
    const orphanSpan = result.unmatched.find(t => t.name === 'span' && !t.isClosing);

    assert.ok(sectionPair, 'section should match its close by searching past the unclosed div/span');
    assert.ok(orphanDiv);
    assert.ok(orphanSpan);
  });

  it('deep nesting still increases depth normally when everything is well formed', () => {
    const text = '<a><b><c><d></d></c></b></a>';
    const result = parseDocument(text, DENYLIST);
    const depthOf = (n: string) => result.pairs.find(p => p.open.name === n)!.depth;
    assert.strictEqual(depthOf('a'), 0);
    assert.strictEqual(depthOf('b'), 1);
    assert.strictEqual(depthOf('c'), 2);
    assert.strictEqual(depthOf('d'), 3);
  });

  it('deeply nested tags with the SAME name each match their own innermost partner', () => {
    // <div><div><div>...</div></div></div>, 7 levels deep. Every closing tag
    // must pair with the nearest still-open <div>, not some other one, and
    // depth must increase monotonically the whole way down.
    const depth = 7;
    const text = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);
    const result = parseDocument(text, DENYLIST);
    assert.strictEqual(result.pairs.length, depth);
    assert.strictEqual(result.unmatched.length, 0);

    const sortedByOpenStart = [...result.pairs].sort((a, b) => a.open.full.start - b.open.full.start);
    sortedByOpenStart.forEach((pair, i) => {
      assert.strictEqual(pair.depth, i, `div opened ${i}-th should be at depth ${i}`);
      // The i-th opened div must close with the (depth-1-i)-th closing tag,
      // i.e. innermost-opened closes innermost-first (proper LIFO nesting).
    });

    // Every pair's open/close must actually be a valid, non-overlapping bracket:
    // open.start < ... < close.start for properly nested same-name tags,
    // and pairs at greater depth must be fully contained within their parent.
    for (const outer of result.pairs) {
      for (const inner of result.pairs) {
        if (inner.depth === outer.depth + 1) {
          assert.ok(inner.open.full.start > outer.open.full.start && inner.close.full.end < outer.close.full.end,
            'child pair must be nested strictly inside its parent pair');
        }
      }
    }
  });
});

describe('findTagAtOffset', () => {
  it('returns the matching partner for a cursor inside an opening tag', () => {
    const text = '<div><span></span></div>';
    const result = parseDocument(text, DENYLIST);
    const offsetInsideDivOpen = 2; // inside "<div>"
    const lookup = findTagAtOffset(result, offsetInsideDivOpen);
    assert.ok(lookup);
    assert.strictEqual(lookup!.tag.name, 'div');
    assert.strictEqual(lookup!.tag.isClosing, false);
    assert.ok(lookup!.partner);
    assert.strictEqual(lookup!.partner!.name, 'div');
    assert.strictEqual(lookup!.partner!.isClosing, true);
  });

  it('returns null partner for an unmatched tag under the cursor', () => {
    const text = '<div><span></div>';
    const result = parseDocument(text, DENYLIST);
    const offsetInsideSpan = 7; // inside "<span>"
    const lookup = findTagAtOffset(result, offsetInsideSpan);
    assert.ok(lookup);
    assert.strictEqual(lookup!.tag.name, 'span');
    assert.strictEqual(lookup!.partner, null);
  });

  it('returns null when the cursor is outside any tag', () => {
    const text = '<div>hello</div>';
    const result = parseDocument(text, DENYLIST);
    const lookup = findTagAtOffset(result, 7); // inside "hello"
    assert.strictEqual(lookup, null);
  });
});
