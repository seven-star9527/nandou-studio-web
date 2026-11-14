import type { ReferenceImage } from './types';

type NamedReference = Pick<ReferenceImage, 'id' | 'name'>;
const pattern = /⟦ref:([a-f0-9-]{32,36})⟧/g;
export const referenceToken = (id: string) => `⟦ref:${id}⟧`;
export const referenceDragType = 'application/x-studio-reference';

export function appendMentions(text: string, refs: NamedReference[]) {
  return text + refs.map(ref => referenceToken(ref.id)).join('');
}
export function removeMentions(text: string, ids: string[]) {
  return text.replace(pattern, (token, id: string) => ids.includes(id) ? '' : token);
}
export function instructionsOnly(text: string) {
  return text.replace(pattern, '').trim();
}
export function resolveMentions(text: string, refs: NamedReference[]) {
  return text.replace(pattern, (_, id: string) => {
    const index = refs.findIndex(ref => ref.id === id);
    return index < 0 ? '' : `【参考图${index + 1}】`;
  });
}
export function bindMentions(text: string, refs: NamedReference[]) {
  return text.replace(/【参考图(\d+)】/g, (label, n) => refs[Number(n) - 1] ? referenceToken(refs[Number(n) - 1].id) : label);
}
export function mentionParts(text: string) {
  return text.split(/(⟦ref:[a-f0-9-]{32,36}⟧)/g).filter(Boolean);
}
