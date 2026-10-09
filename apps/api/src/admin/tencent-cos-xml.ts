import { TencentCosRequestError } from './tencent-cos-client';

export type CosXmlNode = { name: string; children: CosXmlNode[]; text: string };
function invalid(): never { throw new TencentCosRequestError('INVALID_XML_RESPONSE'); }
function decode(text: string) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(text)) invalid();
  return text.replace(/&([^;]+);/g, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity in named) return named[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(code) || code < 32 && ![9, 10, 13].includes(code) || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) invalid();
    return String.fromCodePoint(code);
  });
}
// This reader accepts COS's small XML vocabulary, rejects DTD/entities, and never expands or executes source content.
export function parseCosXml(text: string, rootName: string): CosXmlNode {
  if (Buffer.byteLength(text) > 2 * 1024 ** 2 || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) invalid();
  text = text.replace(/^\uFEFF/, '').replace(/^\s*<\?xml\s[^?]*\?>/, '');
  const document: CosXmlNode = { name: '', text: '', children: [] }, stack = [document];
  let offset = 0, count = 0;
  const tokens = /<[^>]*>|[^<]+/g;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== offset || ++count > 20000) invalid(); offset += match[0].length;
    const token = match[0], current = stack.at(-1)!;
    if (token.startsWith('</')) {
      const name = /^<\/([A-Za-z_][\w:.-]*)\s*>$/.exec(token)?.[1];
      if (stack.length <= 1 || name !== current.name) invalid(); stack.pop();
    } else if (token.startsWith('<')) {
      const open = /^<([A-Za-z_][\w:.-]*)(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*(\/?)>$/.exec(token);
      if (!open || stack.length > 32) invalid();
      const node: CosXmlNode = { name: open[1]!, text: '', children: [] }; current.children.push(node);
      if (!open[2]) stack.push(node);
    } else { current.text += decode(token); }
  }
  if (offset !== text.length || stack.length !== 1 || document.text.trim() || document.children.length !== 1 || document.children[0]!.name !== rootName) invalid();
  return document.children[0]!;
}
export function xmlChildren(node: CosXmlNode, name: string) { return node.children.filter(child => child.name === name); }
export function xmlOne(node: CosXmlNode, name: string) { const children = xmlChildren(node, name); if (children.length !== 1) invalid(); return children[0]!; }
export function xmlText(node: CosXmlNode, name: string) { const child = xmlOne(node, name); if (child.children.length) invalid(); return child.text.trim(); }
export function xmlOptionalText(node: CosXmlNode, name: string) { const children = xmlChildren(node, name); if (!children.length) return null; return xmlText(node, name); }
