// Small DOM/string helpers with no other dependencies.

export function numericCompare(a, b) {
  return parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
