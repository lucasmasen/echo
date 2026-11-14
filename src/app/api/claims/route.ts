import { claimCandidates } from "@/lib/echo/claim-candidates";
import { ARTICLE_TEXT_MAX_CHARS, articleText, fetchPublicPage, isFetchablePublicUrl, stripTags } from "@/lib/echo/pipeline";
import { mayStartPaidWork, PAGE_READ_PRESENTER_ONLY_MESSAGE } from "@/lib/echo/presenter";
import { isJsonRequest, JSON_REQUIRED, readBodyWithin } from "@/lib/echo/request-body";

// "Trace an article": read one public page (free, no model call) and return the sentences worth tracing. It never
// starts a trace; the reader picks a sentence, and only then may they run one. Same public-address rules as Echo's
// other page reads (no private hosts, every redirect checked), bounded in time and size.

export const runtime = "nodejs";
export const maxDuration = 30;
const MAX_BODY_BYTES = 4_096;
const MAX_PAGE_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 8_000;

const json = (status: number, value: unknown) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function readPage(response: Response): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      // A long page is read up to the limit; its article text is near the top.
      if (total >= MAX_PAGE_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(Math.min(total, MAX_PAGE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const room = bytes.length - offset;
    if (room <= 0) break;
    bytes.set(chunk.subarray(0, room), offset);
    offset += Math.min(chunk.byteLength, room);
  }
  const html = decoderFor(bytes, response.headers.get("content-type")).decode(bytes);
  // A page cut at the limit ends mid-text (often mid-sentence or mid-character): only text before its last complete
  // tag is kept, so a fragment is never offered as one of the page's sentences.
  return total >= MAX_PAGE_BYTES ? html.slice(0, html.lastIndexOf(">") + 1) : html;
}

/**
 * A decoder for the page's own encoding, found as a browser does: a byte-order mark, then the content-type's charset,
 * then a <meta charset> near the top. An unknown or missing name reads as UTF-8; a Latin-1 or Shift_JIS page is not
 * turned into replacement characters.
 */
function decoderFor(bytes: Uint8Array, contentType: string | null): TextDecoder {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8");
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4_096));
  const headerLabel = contentType?.match(/;\s*charset\s*=\s*["']?([\w.:-]{1,40})/i)?.[1];
  const metaLabel = headerLabel ? undefined : head.match(/<meta\b[^>]{0,500}?\bcharset\s*=\s*["']?([\w.:-]{1,40})/i)?.[1];
  try {
    const decoder = new TextDecoder(headerLabel ?? metaLabel ?? "utf-8");
    // A <meta> that could be read as ASCII cannot be in UTF-16: a browser reads such a page as UTF-8, and so does Echo.
    return metaLabel && decoder.encoding.startsWith("utf-16") ? new TextDecoder("utf-8") : decoder;
  } catch {
    return new TextDecoder("utf-8");
  }
}

const NAMED: Record<string, string> = { amp: "&", quot: '"', apos: "'", nbsp: " ", lt: "<", gt: ">", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»", bdquo: "„", eacute: "é", copy: "©" };

/** Text with its character references (&amp; &#8217; &#x2014; &mdash;) read as the characters a browser shows. */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (entity, name: string) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? entity;
    const value = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

const MAX_TITLE = 300;

function pageTitle(html: string): string {
  // The first <title>, read as raw text: a "<" in it ("A < B", "<!--") is shown as written, and only "</title" ends it.
  const head = html.slice(0, 200_000);
  const open = head.match(/<title\b[^<>]{0,200}>/i);
  const start = open ? (open.index ?? 0) + open[0].length : -1;
  const close = start < 0 ? -1 : head.toLowerCase().indexOf("</title", start);
  const raw = close > start && close - start <= 4_000 ? head.slice(start, close) : "";
  const title = decodeEntities(raw).replace(/\s+/g, " ").trim();
  if (title.length <= MAX_TITLE) return title;
  // A very long title is shortened at a word, and marked as shortened, rather than dropped.
  const cut = title.slice(0, MAX_TITLE);
  return `${cut.slice(0, cut.lastIndexOf(" ") > MAX_TITLE / 2 ? cut.lastIndexOf(" ") : MAX_TITLE).trimEnd()}…`;
}

// Elements whose content is raw text: a "<!--" inside them is text, not the start of a comment.
const COMMENT_OR_RAW_TEXT = /<!--|<(script|style|textarea|title|xmp|noscript|iframe|noembed|noframes)\b/gi;
const COMMENT_END = /--!?>/g;

/**
 * The page without its HTML comments, in one left-to-right pass. An unclosed comment hides the rest of the page, as
 * it does in a browser; a "<!--" inside a script, style, textarea or title is that element's text and is kept.
 */
function withoutComments(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let position = 0;
  COMMENT_OR_RAW_TEXT.lastIndex = 0;
  for (let match = COMMENT_OR_RAW_TEXT.exec(html); match; match = COMMENT_OR_RAW_TEXT.exec(html)) {
    if (match[1]) {
      // Copied as is up to its closing tag (later steps drop or read it); one left open runs to the end of the page.
      const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index + match[0].length);
      if (close < 0) return out + html.slice(position);
      COMMENT_OR_RAW_TEXT.lastIndex = close;
      continue;
    }
    out += `${html.slice(position, match.index)} `;
    // As a browser parses one: "<!-->" and "<!--->" are empty comments, and "--!>" closes a comment like "-->".
    const body = match.index + 4;
    const empty = html.startsWith(">", body) ? body + 1 : html.startsWith("->", body) ? body + 2 : -1;
    COMMENT_END.lastIndex = body;
    const close = empty < 0 ? COMMENT_END.exec(html) : null;
    if (empty < 0 && !close) return out;
    position = empty >= 0 ? empty : close!.index + close![0].length;
    COMMENT_OR_RAW_TEXT.lastIndex = position;
  }
  return out + html.slice(position);
}

const RAW_TEXT_TAGS = "script|style|textarea|title|xmp|noscript|iframe|noembed|noframes";
// Elements that always need their closing tag, so the end of a hidden one can be found by counting.
const HIDEABLE_TAGS = "div|span|section|article|figure|ul|ol|dl|table|blockquote";
const VISIBILITY_TOKEN = new RegExp(`<(${RAW_TEXT_TAGS})(?![\\w-])|<(/?)(${HIDEABLE_TAGS})(?![\\w-])([^<>]{0,2000})>`, "gi");

/**
 * True for an element a browser never shows: a `hidden` attribute (not hidden="until-found", which find-in-page
 * reveals) or an inline display:none. aria-hidden is not one: it hides text from screen readers, not from the eye.
 */
function isHiddenElement(attributes: string): boolean {
  for (const attribute of attributes.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = attribute[1].toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    if (name === "hidden" && value.trim().toLowerCase() !== "until-found") return true;
    if (name === "style" && /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i.test(value)) return true;
  }
  return false;
}

/** Where the element of `tag` opened just before `from` ends (after its matching close), or -1 when it never closes. */
function endOfElement(html: string, lower: string, tag: string, from: number): number {
  const token = new RegExp(`<(${RAW_TEXT_TAGS})(?![\\w-])|<(/?)${tag}(?![\\w-])[^<>]{0,2000}>`, "gi");
  token.lastIndex = from;
  let depth = 1;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    if (match[1]) {
      const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index + match[0].length);
      if (close < 0) return -1;
      token.lastIndex = close + 2;
      continue;
    }
    depth += match[2] ? -1 : 1;
    if (!depth) return match.index + match[0].length;
  }
  return -1;
}

/**
 * The page without the elements a browser never shows (see isHiddenElement), in linear time. Only an element whose
 * matching close is found is removed; once one of a tag never closes, later ones of that tag are kept, as before,
 * rather than rescanning the page for each. Script and style text is skipped, so a "<div hidden>" in code is not one.
 */
function withoutHidden(html: string): string {
  const lower = html.toLowerCase();
  const unclosed = new Set<string>();
  let out = "";
  let position = 0;
  VISIBILITY_TOKEN.lastIndex = 0;
  for (let match = VISIBILITY_TOKEN.exec(html); match; match = VISIBILITY_TOKEN.exec(html)) {
    if (match[1]) {
      const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index + match[0].length);
      if (close < 0) break;
      VISIBILITY_TOKEN.lastIndex = close + 2;
      continue;
    }
    const tag = match[3].toLowerCase();
    if (match[2] || unclosed.has(tag) || !isHiddenElement(match[4])) continue;
    const end = endOfElement(html, lower, tag, match.index + match[0].length);
    if (end < 0) { unclosed.add(tag); continue; }
    // Nothing is put in its place: a hidden element makes no box, so the text on either side reads as it is shown.
    out += html.slice(position, match.index);
    position = end;
    VISIBILITY_TOKEN.lastIndex = end;
  }
  return out + html.slice(position);
}

// Elements whose text a reader never sees as the article: code, the <title> (the page's name, returned
// separately), menus and page furniture, and form controls.
const UNREAD = /<(script|style|noscript|template|svg|title|nav|header|footer|aside|form|textarea|select|button|iframe|object)\b/gi;

/** The page's readable text: its <article>/<main> paragraphs when it has them, else the body without scripts and styles. */
function readableText(html: string): string {
  const article = articleText(html);
  // A long article's text is cut at ARTICLE_TEXT_MAX_CHARS, mid-paragraph: the cut paragraph (often half a sentence)
  // is dropped, so a fragment is never offered as one of the page's sentences.
  if (article && article.length < ARTICLE_TEXT_MAX_CHARS) return article;
  const lastWhole = article ? article.lastIndexOf("\n\n") : -1;
  if (article && lastWhole > 0) return article.slice(0, lastWhole);
  const lower = html.toLowerCase();
  let text = "";
  let position = 0;
  UNREAD.lastIndex = 0;
  for (let match = UNREAD.exec(html); match; match = UNREAD.exec(html)) {
    text += `${html.slice(position, match.index)} `;
    // A self-closing <svg … /> (an icon) is a whole element, as a browser reads it, not one left open.
    const tagEnd = match[1].toLowerCase() === "svg" ? html.indexOf(">", match.index) : -1;
    if (tagEnd > 0 && html[tagEnd - 1] === "/") {
      position = tagEnd + 1;
      UNREAD.lastIndex = position;
      continue;
    }
    const close = lower.indexOf(`</${match[1].toLowerCase()}`, match.index + match[0].length);
    // An element left open (a page cut at the size limit inside a long inline script) hides everything after it,
    // rather than its code being read as prose.
    if (close < 0) { position = html.length; break; }
    const end = html.indexOf(">", close);
    position = end < 0 ? html.length : end + 1;
    UNREAD.lastIndex = position;
  }
  text += html.slice(position);
  // Each block's text stands alone: a blank line at every block edge (claimCandidates never joins across one), and
  // headings marked "# " as articleText does. No full stops are added, so a suggestion reads exactly as on the page.
  const blocks = text.replace(/\s+/g, " ")
    .replace(/<h[1-6]\b[^>]{0,2000}>/gi, "\n\n# ")
    .replace(/<\/?(?:p|div|li|ul|ol|dl|dt|dd|h[1-6]|section|article|main|blockquote|figure|figcaption|table|thead|tbody|tr|td|th|caption|pre|hr|address|details|summary|fieldset|legend|dialog|center|menu|hgroup)\b[^>]{0,2000}>|<br\s*\/?>/gi, "\n\n");
  return decodeEntities(stripTags(blocks));
}

export async function POST(request: Request) {
  // Reading pages costs nothing, but a public deployment keeps it for the presenter, like every other fetch.
  if (!mayStartPaidWork(request)) return json(403, { code: "PRESENTER_ONLY", error: PAGE_READ_PRESENTER_ONLY_MESSAGE });
  // JSON only, so another site cannot make Echo fetch pages with a form or text/plain POST (see isJsonRequest).
  if (!isJsonRequest(request)) return json(415, JSON_REQUIRED);
  const raw = await readBodyWithin(request, MAX_BODY_BYTES);
  if (raw === null) return json(413, { code: "REQUEST_TOO_LARGE", error: "Send one page address." });
  let url: unknown;
  try {
    url = (JSON.parse(raw) as { url?: unknown }).url;
  } catch {
    return json(400, { code: "CLAIMS_BAD_URL", error: "Send a JSON request with a url field." });
  }
  if (typeof url !== "string" || url.length > 2_000) return json(400, { code: "CLAIMS_BAD_URL", error: "Paste a full page address, starting with https://." });
  const address = url.trim();
  try {
    if (!/^https?:$/.test(new URL(address).protocol)) throw new Error("not http");
  } catch {
    return json(400, { code: "CLAIMS_BAD_URL", error: "Paste a full page address, starting with https://." });
  }
  if (!isFetchablePublicUrl(address)) return json(400, { code: "CLAIMS_URL_REFUSED", error: "Echo only reads public web pages." });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), FETCH_TIMEOUT_MS);
  request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), { once: true });
  try {
    const fetched = await fetchPublicPage(address, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; EchoSourceTracer/0.1)" },
      signal: controller.signal,
    });
    if (!fetched) return json(400, { code: "CLAIMS_URL_REFUSED", error: "Echo only reads public web pages." });
    const { response, finalUrl } = fetched;
    if (!response.ok) {
      response.body?.cancel().catch(() => {});
      return json(502, { code: "CLAIMS_FETCH_FAILED", error: `That page answered ${response.status}. Copy the claim from it and paste it instead.` });
    }
    if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") ?? "")) {
      response.body?.cancel().catch(() => {});
      return json(415, { code: "CLAIMS_NOT_HTML", error: "That address is not a web page Echo can read (a PDF or file?). Copy the claim and paste it instead." });
    }
    const html = withoutComments((await readPage(response)) ?? "");
    const candidates = claimCandidates(readableText(withoutHidden(html)));
    return json(200, { title: pageTitle(html), finalUrl, candidates });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError" || controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError";
    return json(timedOut ? 504 : 502, { code: "CLAIMS_FETCH_FAILED", error: timedOut ? "That page took too long to load. Copy the claim and paste it instead." : "Echo could not read that page. Copy the claim and paste it instead." });
  } finally {
    clearTimeout(timer);
  }
}
