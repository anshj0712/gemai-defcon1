/**
 * The last answer for each request, kept for the life of the tab. A page starts from it, so moving between
 * tabs shows the numbers straight away; the page then asks again and swaps in the fresh answer.
 */
const store = new Map<string, unknown>();

export const peek = <T,>(key: string): T | undefined => store.get(key) as T | undefined;

export function keep<T>(key: string, value: T): T {
  store.set(key, value);
  return value;
}
