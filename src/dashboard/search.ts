/**
 * Case folding for user-facing search over Turkish text.
 *
 * `toLocaleLowerCase("tr")` is correct for display and sorting but wrong for a
 * search box: it maps uppercase `I` to dotless `ı`, so a user typing
 * "istanbul" would not match a campaign named "ISTANBUL". Folding the whole
 * i-family (I, İ, ı, i) to a single `i` before an invariant lowercase makes
 * the match forgiving in every direction, which is what a search field should
 * be. Other Turkish letters (ş, ğ, ö, ü, ç) lowercase correctly on their own
 * and are deliberately left distinct.
 */
export function foldForSearch(value: string): string {
  return value.replace(/[İIı]/g, "i").toLowerCase();
}
