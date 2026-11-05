// Venice rejects any request whose strings contain a null byte (HTTP 400,
// "String must not contain null bytes"). Tool output such as `find -print0` or a
// binary file can carry them, and once one is in a conversation every later
// request with that history fails. They are replaced with U+FFFD before
// anything is sent; nothing else is changed.
export const NULL_BYTE_REPLACEMENT = "�";

// Returns value with null bytes replaced in every string it contains (strings,
// arrays and plain objects, recursively). When a counter is given,
// counter.replaced is increased by the number of replacements.
export function replaceNullBytes(value, counter) {
  if (typeof value === "string") {
    if (!value.includes("\u0000")) {
      return value;
    }
    return value.replace(/\u0000/g, () => {
      if (counter) {
        counter.replaced += 1;
      }
      return NULL_BYTE_REPLACEMENT;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceNullBytes(item, counter));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceNullBytes(item, counter)]),
    );
  }
  return value;
}
