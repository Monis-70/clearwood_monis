/** The value for a mark column (defaultMark, primaryMark): `true` or NULL, never `false`. */
export function mark(flag: boolean): true | null {
  return flag ? true : null;
}
