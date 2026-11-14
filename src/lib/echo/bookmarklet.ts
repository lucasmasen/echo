/**
 * "Trace with Echo" bookmarklet: on any page, the selected text (or, with nothing selected, a typed claim) opens in a
 * new Echo tab as ?claim=… . A ?claim= link only fills the claim box, so the bookmarklet can never start a paid run;
 * the reader still clicks "Trace sources". Text is whitespace-collapsed and cut to Echo's 500-character limit.
 */
export const BOOKMARKLET_MAX_CLAIM = 500;

export function bookmarkletCode(origin: string): string {
  const home = JSON.stringify(`${new URL("/", origin).toString()}?claim=`);
  // Only language built-ins and window.getSelection/prompt/open are used, never the page's URL or String globals,
  // which some pages replace. The cut drops a half emoji (a lone surrogate) so the claim box never shows "\uFFFD".
  return [
    "(()=>{",
    "const w=window,c=(v)=>(''+(v||'')).replace(/\\s+/g,' ').trim();",
    "let s=c(w.getSelection&&w.getSelection());",
    "if(!s)s=c(w.prompt('Claim to trace with Echo:'));",
    "if(!s)return;",
    `s=s.slice(0,${BOOKMARKLET_MAX_CLAIM}).replace(/[\\uD800-\\uDBFF]$/,'');`,
    "if(s.toWellFormed)s=s.toWellFormed();",
    `w.open(${home}+encodeURIComponent(s),'_blank','noopener');`,
    "})()",
  ].join("");
}

/** The bookmark's address: a javascript: URL a browser runs when the bookmark is clicked. */
export function bookmarkletHref(origin: string): string {
  return `javascript:${encodeURIComponent(bookmarkletCode(origin))}`;
}
