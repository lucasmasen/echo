import { originLayer } from "./origin-layer";
import type { EchoAnalysis } from "./types";

// A hint, not a verdict: names that several of a run's origins all mention in the passage Echo saved. Echo traces
// copying between the pages search returned. When the document everything goes back to was NOT returned (a report, a
// book, a study), each page that discusses it can look like an origin of its own. A name most origins share is the
// sign of that. Found by rule from the saved text: no model call, no network.

export interface UpstreamHint {
  /** The name as it is most often written in the passages. */
  name: string;
  /** Origins (counted once per publisher) whose saved passage mentions it. */
  origins: number;
  /** Publishers among the run's origins. */
  of: number;
  /** Those origins' names. */
  originNames: string[];
  /** True when a page of the run is itself that source by its site name (then it is not missing, only shared). */
  amongPages: boolean;
}

const CONNECTORS = new Set(["of", "the", "for", "and", "in", "on", "de", "la", "&", "at", "to"]);
// Words that start sentences or sit in site furniture: never a source's name on their own, and never the edge of one.
const PLAIN = new Set(
  "the a an and but or if in on at to of for from by with as is are was were be been it its this that these those there here he she they we you i his her their our your my not no yes so than then when what why how who which while where after before during about according also however although because since still just only even most more many much some any each every other another new first last next one two three four five six seven eight nine ten study studies report reports research researchers researcher survey data source sources article articles news page pages read share sign subscribe menu home search contact privacy policy terms cookies cookie copyright rights reserved all january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday today yesterday dr mr mrs ms prof professor university institute journal press release update updated published by image photo credit getty images via per cent percent figure table chapter part section key takeaways summary introduction conclusion faq question questions answer answers fact facts check myth myths truth true false claim claims says said say here's what's it's don't isn't that's there's let's can't doesn't won't really actually have has had do does did can could will would should may might must get gets got make makes made take takes took need needs know known think long short average human humans people person year years day days time times half full pdf html www http https video watch listen learn more less best worst top big small good bad old real great high low per vs versus us uk usa americans american world global life work works working business businesses company companies startup startups customer customers money cost costs rate rates number numbers stat stats statistic statistics science scientific scientists expert experts evidence finding findings result results review reviews analysis guide tips ways reasons things thing way why's who's here now ever never always often usually again back down up out off over under into onto between among around through without within like such same different own free online blog post posts story stories comment comments reply related latest popular trending health medical body brain mind memory attention habit habits heat head phone phones generative artificial intelligence ai pilots pilot fail fails failed failure failures".split(" "),
);

function tokens(text: string): string[] {
  return text.replace(/[“”"()[\]{}<>|•·…]/g, " ").split(/\s+/).filter(Boolean);
}
function bare(word: string): string {
  return word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").replace(/[’']s$/i, "");
}
function isName(word: string): boolean {
  const core = bare(word);
  if (core.length < 2 || !/^[A-Z]/.test(core)) return false;
  return !PLAIN.has(core.toLowerCase());
}
function isAcronym(word: string): boolean {
  const core = bare(word);
  return /^[A-Z]{2,6}$/.test(core);
}
function endsSentence(word: string): boolean {
  return /[.!?:;]$/.test(word);
}

/** Candidate names in one passage: runs of two to four capitalised words (connectors allowed inside), and acronyms. */
function candidates(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const words = tokens(text);
  const keep = (phrase: string) => {
    const key = phrase.toLowerCase();
    if (!found.has(key)) found.set(key, phrase);
  };
  for (let start = 0; start < words.length; start += 1) {
    if (!isName(words[start])) continue;
    if (isAcronym(words[start])) keep(bare(words[start]));
    const run = [bare(words[start])];
    let last = start;
    for (let at = start + 1; at < words.length && run.length < 5 && !endsSentence(words[last]); at += 1) {
      const core = bare(words[at]);
      if (isName(words[at])) {
        run.push(core);
        last = at;
        const names = run.filter((word) => !CONNECTORS.has(word.toLowerCase()));
        if (names.length >= 2 && names.length <= 4) keep(run.join(" "));
      } else if (CONNECTORS.has(core.toLowerCase()) && at + 1 < words.length && isName(words[at + 1])) {
        run.push(core.toLowerCase());
        last = at;
      } else break;
    }
  }
  return found;
}

function mentions(text: string, phrase: string): boolean {
  const pattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[\\s\\u00a0-]+");
  return new RegExp(`(^|[^A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, "i").test(text);
}

/** Up to three names that at least half of the run's origin publishers (and at least two) all mention. */
export function upstreamHints(analysis: Pick<EchoAnalysis, "claim" | "pages" | "roots" | "coPublishedRootGroups">): UpstreamHint[] {
  const layer = originLayer(analysis);
  const counted = layer.origins.filter((origin) => origin.counted);
  if (counted.length < 2) return [];
  const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const texts = counted.map((origin) => origin.pageIds.map((id) => byId.get(id)).filter((page) => page !== undefined).map((page) => `${page.title}. ${page.text ?? ""}`).join(" \n "));
  const claim = analysis.claim.toLowerCase();
  // A name is not a shared outside source when it is only the publisher talking about itself.
  const selfNames = counted.map((origin) => `${origin.name} ${origin.entity}`.toLowerCase().replace(/\.(com|org|net|co|uk|edu|gov|io|ai|au|ca)\b/g, " ").replace(/[^a-z0-9]+/g, " "));
  // The site name itself ("scientificamerican" for scientificamerican.com), so "Scientific American" on its own page is not a shared source.
  const selfRoots = selfNames.map((name) => name.split(" ").filter((label) => label.length >= 4));
  const pool = new Map<string, string>();
  for (const text of texts) for (const [key, phrase] of candidates(text)) if (!pool.has(key)) pool.set(key, phrase);
  const need = Math.max(2, Math.ceil(counted.length / 2));
  const hits: Array<UpstreamHint & { key: string }> = [];
  const stem = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  const claimStems = new Set(claim.split(/\s+/).map(stem).filter((word) => word.length >= 3));
  for (const [key, phrase] of pool) {
    if (claim.includes(key)) continue;
    if (key.split(" ").some((word) => !CONNECTORS.has(word) && claimStems.has(stem(word)))) continue;
    const compact = key.replace(/[^a-z0-9]+/g, "");
    const where = texts.map((text, index) => (mentions(text, phrase) && !selfNames[index].replace(/\s+/g, "").includes(compact) && !selfRoots[index].some((root) => compact.includes(root)) ? index : -1)).filter((index) => index >= 0);
    if (where.length < need) continue;
    const amongPages = analysis.pages.some((page) => {
      const host = page.domain.toLowerCase().replace(/^www\./, "");
      return compact.length >= 4 ? host.replace(/[^a-z0-9]+/g, "").includes(compact) : host.split(".").includes(compact);
    });
    hits.push({ key, name: phrase, origins: where.length, of: counted.length, originNames: where.map((index) => counted[index].name), amongPages });
  }
  // The longest name wins over its own parts when the same origins mention both.
  const kept = hits.filter((hit) => !hits.some((other) => other !== hit && other.key.length > hit.key.length && other.key.includes(hit.key) && other.origins >= hit.origins));
  kept.sort((a, b) => b.origins - a.origins || b.key.split(" ").length - a.key.split(" ").length || b.key.length - a.key.length || a.key.localeCompare(b.key));
  return kept.slice(0, 3).map((hit) => ({ name: hit.name, origins: hit.origins, of: hit.of, originNames: hit.originNames, amongPages: hit.amongPages }));
}

const COMMON_CAPS = new Set("social media news video photo photos faq pdf ceo cfo cto usa uk eu ai seo roi kpi vc pr hr it tv app apps new top best free".split(" "));

/** A name many of a run's kept PAGES mention (origins, copies and unplaced alike), one count per site. */
export interface PageName {
  name: string;
  /** Sites among the run's pages whose saved passage mentions it. */
  sites: number;
  /** Sites among the run's pages. */
  of: number;
  /** True when a page of the run comes from a site with that name. */
  amongPages: boolean;
}

/**
 * The wider version of the hint: names that at least three sites and at least three in ten of a run's sites mention,
 * leaving out the claim's own words and a site naming itself. It answers "what do these pages keep pointing at?"
 * for a run whose origins are too few to share anything. By rule, from the saved passages; a lead, not a finding.
 */
export function pageNames(analysis: Pick<EchoAnalysis, "claim" | "pages">): PageName[] {
  const bySite = new Map<string, string>();
  for (const page of analysis.pages) {
    const site = page.domain.toLowerCase().replace(/^www\./, "");
    bySite.set(site, `${bySite.get(site) ?? ""} \n ${page.title}. ${page.text ?? ""}`);
  }
  const sites = [...bySite.keys()];
  if (sites.length < 3) return [];
  const texts = sites.map((site) => bySite.get(site) ?? "");
  const roots = sites.map((site) => site.replace(/\.(com|org|net|co|uk|edu|gov|io|ai|au|ca|nz)\b/g, " ").split(/[^a-z0-9]+/).filter((label) => label.length >= 4));
  const claim = analysis.claim.toLowerCase();
  const stem = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
  const claimStems = new Set(claim.split(/\s+/).map(stem).filter((word) => word.length >= 3));
  const pool = new Map<string, string>();
  for (const text of texts) for (const [key, phrase] of candidates(text)) if (!pool.has(key)) pool.set(key, phrase);
  const need = Math.max(3, Math.ceil(sites.length * 0.3));
  const hits: Array<PageName & { key: string }> = [];
  for (const [key, phrase] of pool) {
    if (claim.includes(key)) continue;
    if (key.split(" ").some((word) => !CONNECTORS.has(word) && claimStems.has(stem(word)))) continue;
    const compact = key.replace(/[^a-z0-9]+/g, "");
    // A lone acronym must be three letters or more and not an everyday word in capitals (MEDIA, VC).
    if (!key.includes(" ") && (key.length < 3 || COMMON_CAPS.has(key))) continue;
    const count = texts.filter((text, index) => mentions(text, phrase) && !roots[index].some((root) => compact.includes(root) || root.includes(compact))).length;
    if (count < need) continue;
    const amongPages = sites.some((site) => (compact.length >= 4 ? site.replace(/[^a-z0-9]+/g, "").includes(compact) : site.split(".").includes(compact)));
    hits.push({ key, name: phrase, sites: count, of: sites.length, amongPages });
  }
  const kept = hits.filter((hit) => !hits.some((other) => other !== hit && other.key.length > hit.key.length && other.key.includes(hit.key) && other.sites >= hit.sites));
  kept.sort((a, b) => b.sites - a.sites || b.key.split(" ").length - a.key.split(" ").length || a.key.localeCompare(b.key));
  return kept.slice(0, 3).map(({ name, sites: count, of, amongPages }) => ({ name, sites: count, of, amongPages }));
}
