/**
 * Mirrors src/dashboard/search.ts so client-side filtering and the server's
 * `q` parameter agree on what matches.
 *
 * `toLocaleLowerCase("tr")` maps uppercase `I` to dotless `ı`, so a user
 * typing "istanbul" would not match a campaign named "ISTANBUL". Folding the
 * whole i-family (I, İ, ı, i) to a single `i` first makes search forgiving in
 * every direction. Other Turkish letters lowercase correctly on their own.
 */
export function foldForSearch(value: string): string {
  return value.replace(/[İIı]/g, "i").toLowerCase();
}
