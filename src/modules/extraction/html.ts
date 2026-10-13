import { load } from "cheerio";
import { Parser } from "htmlparser2";
import { AppError } from "../../shared/errors.js";

/** Bound synchronous parsing work before parse5/CSS selection builds a DOM. */
export function loadBoundedHtml(html: string) {
  if (Buffer.byteLength(html) > 2097152)
    throw new AppError("RESPONSE_TOO_LARGE");
  let nodes = 0;
  let depth = 0;
  let attributes = 0;
  const node = () => {
    if (++nodes > 20000) throw new AppError("HTML_LIMIT");
  };
  const parser = new Parser({
    onopentagname(name) {
      node();
      if (++depth > 128 || name.length > 200) throw new AppError("HTML_LIMIT");
      attributes = 0;
    },
    onattribute(name) {
      if (++attributes > 100 || name.length > 200)
        throw new AppError("HTML_LIMIT");
    },
    onclosetag() {
      depth = Math.max(0, depth - 1);
    },
    ontext: node,
    oncomment: node,
  });
  parser.end(html);
  return load(html);
}
