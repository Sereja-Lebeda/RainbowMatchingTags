# Rainbow Matching Tags

Colors matching HTML/JSX/XML tag pairs by nesting depth, so you can see at a
glance which `<div>` closes which. Click on any tag and its pair lights up
via a background highlight.

Unlike the extension this one is inspired by, a missing or commented-out tag
does not desync the colors of everything after it in the file.

## Features

- **Rainbow-by-depth coloring** — tag pairs are colored by how deeply nested
  they are, not by the order they appear in, so sibling elements at the same
  level share a color.
- **Robust to broken markup** — a missing closing tag, a typo, or a tag that
  got half-commented-out only affects itself (and what's really nested
  inside it). Everything else in the document keeps its correct color.
- **Click-to-highlight** — put the cursor on an opening or closing tag and
  both it and its match get a background highlight.
- **Fully configurable** — colors, highlight style, click-highlight color,
  the color for unmatched tags, which languages it runs on, and which tag
  names it ignores are all settings.

## Why this exists

This started as a fix for [Rainbow Tags by
voldemortensen](https://marketplace.visualstudio.com/items?itemName=voldemortensen.rainbow-tags)
([source](https://gitlab.com/voldemortensen/rainbow-tags), MIT licensed).
That extension is what got me hooked on rainbow tag coloring in the first
place, but I kept hitting the same bug while working in `.tsx` files: as
soon as one tag was missing a closing tag, or a tag got commented out while
debugging, every tag pair *after* it in the file would start showing the
wrong color — sometimes color-pairing with a completely unrelated tag.

Reading its source explained why: it matches a closing tag by blindly
popping whatever was last pushed onto a stack (no name check), and it picks
colors from a counter that only ever increases. One unmatched tag leaves a
stale entry on the stack (or throws the counter out of sync with the real
nesting), and everything downstream inherits the error.

No code from that extension was reused — this is a from-scratch TypeScript
rewrite with a different matching algorithm:

- Closing tags are matched by **searching the stack for the nearest tag with
  the same name**, not by blindly popping the top — the way a browser
  recovers from unclosed tags.
- Colors are assigned by **nesting depth**, computed fresh at every match,
  instead of a counter that drifts once something goes wrong.

The net effect: a broken tag orphans *itself* (shown in a separate,
configurable "unmatched" color) instead of corrupting the rest of the file.

### A concrete example

```html
<section>
  <div>
    <!-- </div> -->   <!-- closing tag commented out on purpose -->
  </div>
</section>
<footer>...</footer>
```

- **Original extension:** `<footer>` (and everything after the broken
  `<div>`) picks up whatever color the stack happens to land on — often the
  wrong one, sometimes matching an unrelated tag.
- **This extension:** the inner `<div>` is flagged as unmatched (its own
  color), `<section>` still matches its real closing tag correctly, and
  `<footer>` — a sibling of `<section>` — gets the *same* color `<section>`
  has, exactly as if the broken block weren't there.

You can see this live: open `demo/demo.html` in the Extension Development
Host (see [Development](#development) below) — it's built specifically to
exercise this case, plus a partially-commented tag, an orphan closing tag,
and 7 levels of same-named nested `<div>`s.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `rainbowMatchingTags.colors` | 8-color palette | Colors used to paint tag pairs, cycling by nesting depth. |
| `rainbowMatchingTags.highlightType` | `"color"` | `"color"`, `"background-color"`, or `"border"` — how the rainbow colors are applied. |
| `rainbowMatchingTags.matchBackgroundColor` | `rgba(255, 215, 0, 0.35)` | Background color applied to a tag and its match when the cursor is on either one. |
| `rainbowMatchingTags.unmatchedColor` | `#e2041b` | Color for tags that couldn't be matched to a pair. |
| `rainbowMatchingTags.allowEverywhere` | `false` | Run on every file type, not just `supportedLanguages`. |
| `rainbowMatchingTags.supportedLanguages` | `html`, `php`, `twig`, `blade`, `smarty`, `xml`, `vue` | Language IDs the extension activates for. |
| `rainbowMatchingTags.denylistTags` | void/meta/structural tags | Tag names that are never colored. |

### A note on JSX/TSX

`javascriptreact` / `typescriptreact` are **not** in `supportedLanguages` by
default. The tag matcher is regex-based, not a real parser, and in `.tsx`
files it can't tell a JSX tag apart from a generic (`useState<Foo>()`) or an
old-style type assertion (`<Type>value`). You can opt in per-project with:

```json
"rainbowMatchingTags.supportedLanguages": ["html", "vue", "javascriptreact", "typescriptreact"]
```

or `"rainbowMatchingTags.allowEverywhere": true` — just expect the occasional false
positive on generics-heavy TypeScript code.

## Installation

Not yet on the VS Code Marketplace (publisher signup is currently blocked by
a regional restriction). In the meantime, install from a `.vsix`:

1. Grab the latest `.vsix` from the [Releases
   page](https://github.com/Sereja-Lebeda/RainbowMatchingTags/releases).
2. In VS Code: Extensions view → `...` menu → **Install from VSIX...** → pick
   the downloaded file.
   - Or from the command line: `code --install-extension rainbow-matching-tags-<version>.vsix`

Updating works the same way — download the newer `.vsix` and install it
again over the old one.

## Development

```sh
npm install
npm run compile
npm test
```

To try it in a real editor window without installing it:

```sh
code --extensionDevelopmentPath=. --new-window demo/demo.html
```

## License

MIT — see [LICENSE](./LICENSE).
