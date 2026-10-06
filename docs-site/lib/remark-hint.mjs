// GitBook hints ({% hint style="warning" %} ... {% endhint %}) as Fumadocs
// Callouts. scripts/sync-docs.mjs puts each marker in a paragraph of its own.
const types = { info: 'info', success: 'success', warning: 'warn', danger: 'error' };
const OPEN = /^\{%\s*hint\s+style="(\w+)"\s*%\}$/;
const CLOSE = /^\{%\s*endhint\s*%\}$/;

const text = (node) =>
  node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text'
    ? node.children[0].value.trim()
    : null;

function replace(children) {
  for (let i = 0; i < children.length; i++) {
    const open = text(children[i])?.match(OPEN);
    if (!open) continue;
    const end = children.findIndex((n, j) => j > i && CLOSE.test(text(n) ?? ''));
    if (end === -1) throw new Error('remark-hint: {% hint %} without {% endhint %}');
    children.splice(i, end - i + 1, {
      type: 'mdxJsxFlowElement',
      name: 'Callout',
      attributes: [{ type: 'mdxJsxAttribute', name: 'type', value: types[open[1]] ?? 'info' }],
      children: children.slice(i + 1, end),
    });
  }
}

export function remarkHint() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return;
      replace(node.children);
      node.children.forEach(walk);
    };
    walk(tree);
  };
}
