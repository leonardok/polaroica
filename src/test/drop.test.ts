// The grid-to-tree drag: a photo dragged out of a grid tab onto a folder in the Libraries view.
//
// The drag gesture itself lives in the webview (media/grid.js `onDragStart`) and can only be
// made by a real mouse in a real editor. What is testable is everything after it: the payload
// the grid writes is a plain `text/uri-list` string, and `LibraryTree.handleDrop` turns it back
// into the files to move. These tests drive that side with exactly what the grid produces, so a
// change to either end that breaks the hand-off fails here.
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as path from 'path';
import { test } from 'node:test';

// ---- a `vscode` stub, so the tree can be loaded outside the extension host ----------------

class StubUri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string): StubUri {
    return new StubUri('file', p);
  }
  static parse(value: string, strict?: boolean): StubUri {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^?#]*)/.exec(value);
    if (!m) {
      if (strict) {
        throw new Error(`not a URI: ${value}`);
      }
      return new StubUri('', value);
    }
    return new StubUri(m[1], decodeURIComponent(m[2]));
  }
  /** `file:///photos/a.ARW`, the same shape the real Uri gives the webview (src/details.ts). */
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

const vscodeStub = {
  Uri: StubUri,
  EventEmitter: class {
    readonly event = (): { dispose(): void } => ({ dispose: () => undefined });
    fire(): void {}
  },
  DataTransferItem: class {
    constructor(readonly value: unknown) {}
  },
  ThemeIcon: class {},
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  MarkdownString: class {
    value = '';
    appendMarkdown(): this {
      return this;
    }
  },
  workspace: { fs: {}, getConfiguration: () => ({ get: () => undefined }) },
  window: { showWarningMessage: async () => undefined },
};

const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string };
const resolve = loader._resolveFilename;
loader._resolveFilename = function (request: string, ...rest: unknown[]): string {
  return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as NodeModule;

// Required (not imported) so the stub above is in place first.
const { LibraryTree, FolderNode, LibraryNode } = require('../tree') as typeof import('../tree');

// ---- harness -------------------------------------------------------------------------------

type Drop = { files: string[]; target: string };

/** A tree whose drops are collected instead of moved. */
function treeThatCollects(): { tree: InstanceType<typeof LibraryTree>; drops: Drop[] } {
  const drops: Drop[] = [];
  const store = { onDidChange: () => undefined, invalidate: () => undefined };
  const libraries = { crumbs: () => ['Library'], all: () => [] };
  const tree = new LibraryTree(
    libraries as never,
    store as never,
    async (files, target) => void drops.push({ files: files.map((f) => f.fsPath), target: target.fsPath }),
  );
  return { tree, drops };
}

/** A DataTransfer holding the given mime types, like the one VS Code hands `handleDrop`. */
function transfer(items: Record<string, string>): never {
  return {
    get: (mime: string) => (mime in items ? { asString: async () => items[mime] } : undefined),
  } as never;
}

/** What media/grid.js writes for a selection of photos in one folder. */
function gridDrag(names: string[], folder: string): Record<string, string> {
  return {
    'text/uri-list': names.map((n) => StubUri.file(path.join(folder, n)).toString()).join('\r\n'),
    'text/plain': names.map((n) => path.join(folder, n)).join('\n'),
  };
}

const SHOOT = path.join('/photos', '2026', 'shoot');
const KEEPERS = path.join('/photos', '2026', 'keepers');
const folderNode = (p: string) => new FolderNode(StubUri.file(p) as never, new LibraryNode({ uri: StubUri.file('/photos') } as never));

// ---- tests ---------------------------------------------------------------------------------

test('the mime the grid writes is one the tree accepts', () => {
  const { tree } = treeThatCollects();
  assert.ok(tree.dropMimeTypes.includes('text/uri-list'));
});

test('photos dragged from the grid onto a folder are moved there', async () => {
  const { tree, drops } = treeThatCollects();
  await tree.handleDrop(folderNode(KEEPERS), transfer(gridDrag(['a.ARW', 'b.ARW'], SHOOT)));
  assert.deepEqual(drops, [{ files: [path.join(SHOOT, 'a.ARW'), path.join(SHOOT, 'b.ARW')], target: KEEPERS }]);
});

test('dropping photos back on the folder they came from does nothing', async () => {
  const { tree, drops } = treeThatCollects();
  await tree.handleDrop(folderNode(SHOOT), transfer(gridDrag(['a.ARW'], SHOOT)));
  assert.deepEqual(drops, []);
});

test('a folder dropped on itself does nothing', async () => {
  const { tree, drops } = treeThatCollects();
  await tree.handleDrop(folderNode(SHOOT), transfer({ 'text/uri-list': StubUri.file(SHOOT).toString() }));
  assert.deepEqual(drops, []);
});

test('comments, blank lines and non-file URIs are left out', async () => {
  const { tree, drops } = treeThatCollects();
  const list = [
    '# a uri-list may carry comments',
    '',
    StubUri.file(path.join(SHOOT, 'c.ARW')).toString(),
    'https://example.com/not-a-file.jpg',
    'untitled:Untitled-1',
  ].join('\r\n');
  await tree.handleDrop(folderNode(KEEPERS), transfer({ 'text/uri-list': list }));
  assert.deepEqual(drops, [{ files: [path.join(SHOOT, 'c.ARW')], target: KEEPERS }]);
});

test('a drop with no target, or no uri-list, does nothing', async () => {
  const { tree, drops } = treeThatCollects();
  await tree.handleDrop(undefined, transfer(gridDrag(['a.ARW'], SHOOT)));
  await tree.handleDrop(folderNode(KEEPERS), transfer({ 'text/plain': path.join(SHOOT, 'a.ARW') }));
  assert.deepEqual(drops, []);
});

test('dragging folders out of the tree offers them as a uri-list', () => {
  const { tree } = treeThatCollects();
  const written = new Map<string, unknown>();
  const data = { set: (mime: string, item: { value: unknown }) => written.set(mime, item.value) };
  tree.handleDrag([folderNode(SHOOT), folderNode(KEEPERS)], data as never);
  assert.equal(written.get('text/uri-list'), `file://${SHOOT}\r\nfile://${KEEPERS}`);
});
