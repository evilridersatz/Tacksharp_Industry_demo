/**
 * Which presented property did the customer mean? "Green Valley", "the first one", "second",
 * "முதல் ஒன்னு". Returns undefined unless exactly one property matches.
 */
import { norm } from './text.js';
import type { PresentedProperty } from './session.js';

const GENERIC = new Set(['residency', 'towers', 'tower', 'heights', 'square', 'plots', 'plot', 'meadows', 'villas', 'villa', 'apartments', 'gardens', 'garden', 'enclave', 'park', 'city', 'acres', 'view', 'the']);

const FIRST = ['first', '1st', 'one', 'முதல்', 'முதலாவது', 'முதல் ஒன்னு', 'mudhal', 'mudhalavadhu', 'onnavadhu', 'முதல்ல'];
const SECOND = ['second', '2nd', 'two', 'இரண்டாவது', 'ரெண்டாவது', 'rendavadhu', 'irandavadhu', 'இரண்டாவது ஒன்னு'];

const has = (n: string, list: string[]) => list.some((w) => ` ${n} `.includes(` ${norm(w)} `));

export function matchPresented(text: string, presented: readonly PresentedProperty[]): PresentedProperty | undefined {
  if (presented.length === 0) return undefined;
  const n = norm(text);
  if (!n) return undefined;
  const toks = n.split(' ');

  const byName = presented.filter((p) => {
    const distinctive = norm(p.name).split(' ').filter((t) => t.length >= 4 && !GENERIC.has(t));
    return distinctive.some((d) => toks.some((t) => t === d || (t.startsWith(d) && t.length - d.length <= 4)));
  });
  if (byName.length === 1) return byName[0];

  if (presented.length >= 2) {
    const wantsFirst = has(n, FIRST) && /\b(first|1st|முதல்|mudhal)/u.test(n);
    const wantsSecond = has(n, SECOND);
    if (wantsFirst && !wantsSecond) return presented[0];
    if (wantsSecond && !wantsFirst) return presented[1];
  }
  return undefined;
}

/**
 * A property from the WHOLE inventory named in the utterance ("Anna Nagar Residency", "அப்போ Anna Nagar Residency-ல"),
 * not only the ones already read out. Real call 2026-10-10: "Anna Nagar Residency" was taken as the area "Anna Nagar"
 * and searched with the old BHK / budget - "nothing there" - while that property was in the inventory.
 *  - the full name in the utterance wins;
 *  - otherwise a distinctive word of the name that is NOT an area name ("Green Valley", "Premium") picks it, when
 *    exactly one property has it. Area words alone ("Anna Nagar") never pick a property: that is an area request.
 */
export function findNamedProperty<T extends { id: string; name: string; location: string }>(
  text: string,
  inventory: readonly T[],
  areaNames: readonly string[] = [],
): T | undefined {
  const n = ` ${norm(text)} `;
  if (n.trim().length < 3) return undefined;
  const toks = n.trim().split(' ');
  const areaWords = new Set(
    [...areaNames, ...inventory.map((p) => p.location.split(',')[0])].flatMap((a) => norm(a).split(' ')).filter(Boolean),
  );
  const hasTok = (d: string) => toks.some((t) => t === d || (t.startsWith(d) && t.length - d.length <= 4));
  const full = inventory.filter((p) => {
    const words = norm(p.name).split(' ').filter(Boolean);
    return words.length > 0 && words.every((w) => hasTok(w));
  });
  if (full.length === 1) return full[0];
  if (full.length > 1) {
    // "Green Valley Residency" vs "Green Valley": the longest full match.
    const longest = [...full].sort((a, b) => norm(b.name).length - norm(a.name).length);
    if (norm(longest[0].name).length > norm(longest[1].name).length) return longest[0];
    return undefined;
  }
  const partial = inventory.filter((p) =>
    norm(p.name).split(' ').some((w) => w.length >= 4 && !GENERIC.has(w) && !areaWords.has(w) && hasTok(w)),
  );
  return partial.length === 1 ? partial[0] : undefined;
}
