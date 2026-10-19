/**
 * `text` with each occurrence of `query` marked, matched the way Search
 * filters: on the lowercased text, with the query already lowercased.
 */
export function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: Array<string | JSX.Element> = [];
  let at = 0;
  for (let index = lower.indexOf(query); index !== -1; index = lower.indexOf(query, at)) {
    if (index > at) parts.push(text.slice(at, index));
    parts.push(
      <mark key={index} className="search-hit">
        {text.slice(index, index + query.length)}
      </mark>
    );
    at = index + query.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
