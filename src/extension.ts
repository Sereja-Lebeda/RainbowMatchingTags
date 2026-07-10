import * as vscode from 'vscode';
import { parseDocument, findTagAtOffset, ParseResult, OffsetRange } from './tagParser';

interface RainbowTagsConfig {
  colors: string[];
  highlightType: 'color' | 'background-color' | 'border';
  matchBackgroundColor: string;
  unmatchedColor: string;
  allowEverywhere: boolean;
  supportedLanguages: string[];
  denylistTags: string[];
}

interface CachedParse {
  version: number;
  result: ParseResult;
}

let colorDecorationTypes: vscode.TextEditorDecorationType[] = [];
let unmatchedDecorationType: vscode.TextEditorDecorationType | undefined;
let matchDecorationType: vscode.TextEditorDecorationType | undefined;

// Cache the parse per document+version so typing in one editor and moving
// the cursor around doesn't reparse the whole document on every event.
let parseCache = new WeakMap<vscode.TextDocument, CachedParse>();

const CONFIG_SECTION = 'rainbowMatchingTags';

function getConfig(): RainbowTagsConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    colors: cfg.get<string[]>('colors', []),
    highlightType: cfg.get<RainbowTagsConfig['highlightType']>('highlightType', 'color'),
    matchBackgroundColor: cfg.get<string>('matchBackgroundColor', 'rgba(255, 215, 0, 0.35)'),
    unmatchedColor: cfg.get<string>('unmatchedColor', '#e2041b'),
    allowEverywhere: cfg.get<boolean>('allowEverywhere', false),
    supportedLanguages: cfg.get<string[]>('supportedLanguages', []),
    denylistTags: cfg.get<string[]>('denylistTags', [])
  };
}

function isSupported(document: vscode.TextDocument, config: RainbowTagsConfig): boolean {
  return config.allowEverywhere || config.supportedLanguages.includes(document.languageId);
}

function disposeDecorationTypes(): void {
  colorDecorationTypes.forEach(d => d.dispose());
  colorDecorationTypes = [];
  unmatchedDecorationType?.dispose();
  unmatchedDecorationType = undefined;
  matchDecorationType?.dispose();
  matchDecorationType = undefined;
}

function createDecorationTypes(config: RainbowTagsConfig): void {
  disposeDecorationTypes();

  colorDecorationTypes = config.colors.map(color => {
    let style: vscode.DecorationRenderOptions;
    switch (config.highlightType) {
      case 'background-color':
        style = { backgroundColor: color };
        break;
      case 'border':
        style = { border: '1px solid ' + color };
        break;
      default:
        style = { color };
        break;
    }
    return vscode.window.createTextEditorDecorationType(style);
  });

  unmatchedDecorationType = vscode.window.createTextEditorDecorationType({
    color: config.unmatchedColor
  });

  // Always a background change, regardless of highlightType, per the
  // "click a tag, its pair lights up" behavior this is meant to give.
  matchDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: config.matchBackgroundColor
  });
}

function parseAndCache(document: vscode.TextDocument, denylist: ReadonlySet<string>): ParseResult {
  const cached = parseCache.get(document);
  if (cached && cached.version === document.version) {
    return cached.result;
  }
  const result = parseDocument(document.getText(), denylist);
  parseCache.set(document, { version: document.version, result });
  return result;
}

function toRange(document: vscode.TextDocument, r: OffsetRange): vscode.Range {
  return new vscode.Range(document.positionAt(r.start), document.positionAt(r.end));
}

function renderRainbowTags(editor: vscode.TextEditor | undefined, config: RainbowTagsConfig): void {
  if (!editor || !unmatchedDecorationType) {
    return;
  }
  if (!isSupported(editor.document, config)) {
    return;
  }

  const denylist = new Set(config.denylistTags.map(t => t.toLowerCase()));
  const result = parseAndCache(editor.document, denylist);

  if (colorDecorationTypes.length > 0) {
    const buckets: vscode.Range[][] = colorDecorationTypes.map(() => []);
    for (const pair of result.pairs) {
      const idx = pair.depth % colorDecorationTypes.length;
      buckets[idx].push(toRange(editor.document, pair.open.nameRange));
      if (pair.open.closeBracketRange) {
        buckets[idx].push(toRange(editor.document, pair.open.closeBracketRange));
      }
      buckets[idx].push(toRange(editor.document, pair.close.nameRange));
    }
    colorDecorationTypes.forEach((decoType, i) => editor.setDecorations(decoType, buckets[i]));
  }

  const unmatchedRanges: vscode.Range[] = [];
  for (const tag of result.unmatched) {
    unmatchedRanges.push(toRange(editor.document, tag.nameRange));
    if (tag.closeBracketRange) {
      unmatchedRanges.push(toRange(editor.document, tag.closeBracketRange));
    }
  }
  editor.setDecorations(unmatchedDecorationType, unmatchedRanges);
}

function renderMatchHighlight(editor: vscode.TextEditor | undefined, config: RainbowTagsConfig): void {
  if (!editor || !matchDecorationType) {
    return;
  }
  if (!isSupported(editor.document, config)) {
    editor.setDecorations(matchDecorationType, []);
    return;
  }

  const denylist = new Set(config.denylistTags.map(t => t.toLowerCase()));
  const result = parseAndCache(editor.document, denylist);
  const offset = editor.document.offsetAt(editor.selection.active);
  const lookup = findTagAtOffset(result, offset);

  if (!lookup) {
    editor.setDecorations(matchDecorationType, []);
    return;
  }

  const ranges = [toRange(editor.document, lookup.tag.full)];
  if (lookup.partner) {
    ranges.push(toRange(editor.document, lookup.partner.full));
  }
  editor.setDecorations(matchDecorationType, ranges);
}

export function activate(context: vscode.ExtensionContext): void {
  let config = getConfig();
  createDecorationTypes(config);

  const renderEditor = (editor: vscode.TextEditor | undefined) => {
    renderRainbowTags(editor, config);
    renderMatchHighlight(editor, config);
  };

  const renderAllVisible = () => {
    vscode.window.visibleTextEditors.forEach(renderEditor);
  };

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRender = (editor: vscode.TextEditor | undefined) => {
    if (!editor) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => renderEditor(editor), 75);
  };

  renderAllVisible();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => renderEditor(editor)),

    vscode.window.onDidChangeVisibleTextEditors(() => renderAllVisible()),

    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        scheduleRender(editor);
      }
    }),

    vscode.window.onDidChangeTextEditorSelection(event => {
      renderMatchHighlight(event.textEditor, config);
    }),

    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      config = getConfig();
      parseCache = new WeakMap();
      createDecorationTypes(config);
      renderAllVisible();
    })
  );
}

export function deactivate(): void {
  disposeDecorationTypes();
}
