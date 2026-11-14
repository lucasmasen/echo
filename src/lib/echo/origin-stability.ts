import { ORIGIN_TYPE_LABELS, originLayer, registrableDomain, type LayerOrigin, type OriginType, type ScoreLabel } from "./origin-layer";
import { routedBy, savedMatch, type SavedRun } from "./saved-check";

// "How stable is a score?": saved runs of the SAME claim, side by side. A score rates what one run retrieved, so two
// runs of one claim can score far apart. This file says by how much, what the two runs share, and which origins one
// kept and the other did not. Every figure comes from originLayer on the saved traces. Nothing here reads a file,
// calls a model or touches the network. Two runs of a claim are far too few to say which search route is better, and
// nothing here ranks one.

export type StabilityRoute = "Telem" | "Tavily";

/** One origin as the comparison names it. */
export interface StabilityOrigin {
  /**
   * What makes two origins the same across runs: the publisher (the origin layer's own rule), or, on a host many
   * publishers share (a video site, a paper index, a wire service), the page address, because there each page counts
   * on its own.
   */
  key: string;
  /** The origin's site, as the rest of the page names it. */
  name: string;
  type: OriginType;
  ownEvidence: boolean;
}

/** One saved run of the claim. */
export interface StabilityRun {
  file: string;
  /** When the run was captured (ISO, UTC), from the trace. */
  captured: string;
  /** The Pacific calendar day of the capture as YYYY-MM-DD, or "" when the timestamp does not parse. */
  day: string;
  searchedThrough: StabilityRoute;
  /** Pages Echo kept as about the claim. */
  pages: number;
  origins: number;
  originsWithOwnEvidence: number;
  /** Rates the evidence base this run found (0 to 100). Not a truth rating. */
  score: number;
  label: ScoreLabel;
}

/** One claim with two or more saved runs: the earliest and the latest of them, and what the two share. */
export interface StabilityPair {
  /** The claim as the later run worded it. */
  claim: string;
  /** How many saved runs of this claim were handed in. The comparison is between the earliest and the latest. */
  savedRuns: number;
  earlier: StabilityRun;
  later: StabilityRun;
  /** Points between the two scores (never negative). */
  gap: number;
  sameDay: boolean;
  sameRoute: boolean;
  /** Pages in both runs, by address (see pageAddress), sister addresses included. The same count whichever run is read first. */
  sharedPages: number;
  /** Distinct page addresses in each run: what sharedPages is out of. */
  earlierAddresses: number;
  laterAddresses: number;
  /** Origins in both runs, and the origins only one run kept. The three lists never overlap. */
  sharedOrigins: StabilityOrigin[];
  onlyEarlier: StabilityOrigin[];
  onlyLater: StabilityOrigin[];
  /** Publishers counted toward each score that show evidence of their own, and those that do not. */
  counted: { earlier: { withEvidence: number; without: number }; later: { withEvidence: number; without: number } };
  /**
   * One article that sits at two sister addresses, one in each run: the same path on two hosts of one name (bbc.com
   * and bbc.co.uk). It is counted once: it is in sharedPages, and when it is an origin in both runs the two are one
   * origin here. The hosts are named so the screen can say so.
   */
  sisterPages: Array<{ earlier: string; later: string }>;
  /** Why the scores differ or match, in plain words, built from the record above. */
  why: string;
  /** A sentence naming the sister addresses when sisterPages is not empty, else null. */
  sisterNote: string | null;
}

// Query parameters that follow a visitor around and do not name the page. Everything else in a query is kept: a video
// address is its "v", and a library record is its "article" or "contentid".
const NOT_THE_PAGE = /^(?:utm_[a-z0-9_]+|fbclid|gclid|gbraid|wbraid|msclkid|srsltid|igshid|mc_cid|mc_eid|ref|ref_src|ref_url|referrer|source|src|cmpid|ocid|share|si|feature|code|error|vl|hl|lang|amp|output)$/i;

/**
 * A page's address for matching it across runs: no protocol, no "www.", no trailing slash, no fragment, the host in
 * lower case, and no tracking or session parameters. A parameter that names the page stays (sorted), so two videos on
 * one site are two pages.
 */
export function pageAddress(url: string): string {
  const bare = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/#.*$/, "");
  const mark = bare.indexOf("?");
  const before = mark === -1 ? bare : bare.slice(0, mark);
  const slash = before.indexOf("/");
  const host = (slash === -1 ? before : before.slice(0, slash)).toLowerCase().replace(/^www\./, "");
  const path = slash === -1 ? "" : before.slice(slash).replace(/\/+$/, "");
  const kept = (mark === -1 ? "" : bare.slice(mark + 1)).split("&").filter((part) => part && !NOT_THE_PAGE.test(part.split("=")[0])).sort();
  return `${host}${path}${kept.length ? `?${kept.join("&")}` : ""}`;
}

/** The Pacific calendar day of a timestamp as YYYY-MM-DD (sorts as text), or "" when it does not parse. */
function pacificDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

function inWords(value: number): string {
  return SMALL_NUMBERS[value] ?? value.toLocaleString("en-US");
}

/** "a", "a and b", "a, b and c". The same entry twice is written once ("youtube.com twice"): two pages of one site. */
function listed(entries: string[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  const unique = [...counts].map(([entry, times]) => (times === 1 ? entry : times === 2 ? `${entry} twice` : `${entry} ${inWords(times)} times`));
  return unique.length <= 1 ? unique.join("") : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/** The origins' sites as one phrase ("a, b and c"), or "" for none. Two pages of one site are written once ("youtube.com twice"). */
export function originNames(origins: readonly StabilityOrigin[]): string {
  return listed(origins.map((origin) => origin.name));
}

/** "bbc.com (original reporting)". */
function typed(origin: StabilityOrigin): string {
  return `${origin.name} (${ORIGIN_TYPE_LABELS[origin.type].toLowerCase()})`;
}

interface Side {
  run: StabilityRun;
  addresses: Map<string, { host: string; path: string }>;
  /** Every origin of the run, one entry per key, in the origin layer's order. */
  origins: Map<string, StabilityOrigin>;
  /** The addresses of each origin's own pages, by origin key. */
  originAddresses: Map<string, string[]>;
  /** The origins counted toward the score (one per publisher) that show evidence of their own. */
  evidenced: Map<string, StabilityOrigin>;
  /** Origins counted toward the score with no evidence of their own. */
  bare: number;
  /** The weight the evidenced origins add to the score. */
  evidenceWeight: number;
  /** A publisher with more than one origin in this run: it counts once. */
  repeated: Array<{ name: string; origins: number }>;
}

function originKey(origin: LayerOrigin): string {
  return origin.entity.includes("#") ? `page:${pageAddress(origin.url)}` : origin.entity;
}

function sideOf({ file, analysis }: SavedRun): Side {
  const layer = originLayer(analysis);
  const addresses = new Map<string, { host: string; path: string }>();
  for (const page of analysis.pages) {
    const address = pageAddress(page.url);
    const slash = address.indexOf("/");
    if (!addresses.has(address)) addresses.set(address, { host: slash === -1 ? address : address.slice(0, slash), path: slash === -1 ? "" : address.slice(slash) });
  }
  const urlOf = new Map(analysis.pages.map((page) => [page.id, page.url] as const));
  const origins = new Map<string, StabilityOrigin>();
  const originAddresses = new Map<string, string[]>();
  const evidenced = new Map<string, StabilityOrigin>();
  const perPublisher = new Map<string, { name: string; origins: number }>();
  let bare = 0;
  let evidenceWeight = 0;
  for (const origin of layer.origins) {
    const key = originKey(origin);
    const entry: StabilityOrigin = { key, name: origin.name, type: origin.type, ownEvidence: origin.ownEvidence };
    if (!origins.has(key)) origins.set(key, entry);
    originAddresses.set(key, [...(originAddresses.get(key) ?? []), ...origin.pageIds.flatMap((id) => (urlOf.has(id) ? [pageAddress(urlOf.get(id) ?? "")] : []))]);
    const publisher = perPublisher.get(origin.entity) ?? { name: origin.entity.includes("#") ? origin.name : origin.entity, origins: 0 };
    publisher.origins += 1;
    perPublisher.set(origin.entity, publisher);
    if (!origin.counted) continue;
    if (origin.ownEvidence) {
      evidenced.set(key, entry);
      evidenceWeight += origin.weight;
    } else bare += 1;
  }
  return {
    run: {
      file,
      captured: analysis.createdAt,
      day: pacificDay(analysis.createdAt),
      searchedThrough: routedBy(analysis) === "telem" ? "Telem" : "Tavily",
      pages: layer.results,
      origins: layer.origins.length,
      originsWithOwnEvidence: layer.origins.filter((origin) => origin.ownEvidence).length,
      score: layer.score,
      label: layer.label,
    },
    addresses,
    origins,
    originAddresses,
    evidenced,
    bare,
    evidenceWeight,
    repeated: [...perPublisher.values()].filter((publisher) => publisher.origins > 1),
  };
}

/** Why the two scores differ or match: which origins with evidence of their own one run kept and the other did not. */
function whyOf(earlier: Side, later: Side): string {
  const onlyEarlier = [...earlier.evidenced.values()].filter((origin) => !later.evidenced.has(origin.key));
  const onlyLater = [...later.evidenced.values()].filter((origin) => !earlier.evidenced.has(origin.key));
  const both = [...later.evidenced.values()].filter((origin) => earlier.evidenced.has(origin.key));
  const own = (count: number) => `${count === 1 ? "an origin" : "origins"} with evidence of ${count === 1 ? "its" : "their"} own`;
  const sameScore = earlier.run.score === later.run.score;
  const parts: string[] = [];
  if (!earlier.evidenced.size && !later.evidenced.size) {
    if (!earlier.run.origins && !later.run.origins) parts.push("Neither run kept a page Echo counted as an origin.");
    else {
      parts.push("Neither run kept an origin with evidence of its own.");
      parts.push(earlier.bare === later.bare
        ? `Each counted ${inWords(earlier.bare)} without it, so the scores match.`
        : `The earlier run counted ${inWords(earlier.bare)} ${earlier.bare === 1 ? "origin" : "origins"} without it and the later run ${inWords(later.bare)}. That count is the whole gap.`);
    }
  } else if (!onlyEarlier.length && !onlyLater.length) {
    parts.push(`Both runs kept the same ${both.length === 1 ? "origin" : `${inWords(both.length)} origins`} with evidence of ${both.length === 1 ? "its" : "their"} own: ${listed(both.map(typed))}.`);
    if (sameScore) parts.push("So the score did not move.");
    else if (Math.abs(earlier.evidenceWeight - later.evidenceWeight) < 1e-9) parts.push(`The gap comes from origins without it: ${inWords(earlier.bare)} in the earlier run, ${inWords(later.bare)} in the later.`);
    else parts.push("Echo typed them differently in the two runs, and an origin’s type sets its weight.");
  } else {
    // Whether the other run kept the page at all: an origin one run counted can be a page the other never returned.
    const alsoKeptBy = (list: StabilityOrigin[], from: Side, other: Side) => list.filter((origin) => (from.originAddresses.get(origin.key) ?? []).some((address) => other.addresses.has(address)));
    const elsewhere = [...alsoKeptBy(onlyEarlier, earlier, later), ...alsoKeptBy(onlyLater, later, earlier)];
    const moved = onlyEarlier.length + onlyLater.length;
    const those = moved === 1 ? "That page is not" : moved === 2 ? "Neither page is" : "None of those pages is";
    if (onlyEarlier.length && onlyLater.length) {
      parts.push(`The earlier run kept ${listed(onlyEarlier.map(typed))} as ${own(onlyEarlier.length)} and the later run did not; the later run kept ${listed(onlyLater.map(typed))} and the earlier did not.`);
      parts.push(elsewhere.length ? `The other run did keep ${elsewhere.length === 1 ? "a page" : "pages"} from ${listed(elsewhere.map((origin) => origin.name))}, without counting ${elsewhere.length === 1 ? "it" : "them"} as ${own(elsewhere.length)}.` : `${those} among the pages the other run kept.`);
    } else {
      const [from, other, list] = onlyEarlier.length ? (["earlier", "later", onlyEarlier] as const) : (["later", "earlier", onlyLater] as const);
      const otherHasNone = !(onlyEarlier.length ? later : earlier).evidenced.size;
      parts.push(`The ${from} run kept ${listed(list.map(typed))} as ${own(list.length)}.`);
      const tail = otherHasNone ? `, and the ${other} run kept no origin with evidence of its own.` : ".";
      parts.push(elsewhere.length
        ? `The ${other} run did keep ${elsewhere.length === 1 ? "a page" : "pages"} from ${listed(elsewhere.map((origin) => origin.name))}, without counting ${elsewhere.length === 1 ? "it" : "them"} as ${own(elsewhere.length)}${tail}`
        : `${those} among the pages the ${other} run kept${tail}`);
    }
    if (both.length) parts.push(`Both kept ${listed(both.map(typed))}.`);
  }
  for (const [label, side] of [["earlier", earlier], ["later", later]] as const) {
    for (const publisher of side.repeated) parts.push(`The ${label} run kept ${inWords(publisher.origins)} origins from ${publisher.name}; a publisher counts once.`);
  }
  return parts.join(" ");
}

interface Sister {
  earlierAddress: string;
  laterAddress: string;
  earlier: string;
  later: string;
}

/**
 * The same article at two sister addresses, one in each run: the same path on two hosts whose names start alike
 * (bbc.com and bbc.co.uk). Only pages that are not already in both runs are paired, each at most once.
 */
function sisterPagesOf(earlier: Side, later: Side): Sister[] {
  const found: Sister[] = [];
  const taken = new Set<string>();
  for (const [address, a] of earlier.addresses) {
    if (later.addresses.has(address) || a.path.length < 2) continue;
    for (const [other, b] of later.addresses) {
      if (taken.has(other) || earlier.addresses.has(other) || a.host === b.host || a.path !== b.path) continue;
      if (registrableDomain(a.host).split(".")[0] !== registrableDomain(b.host).split(".")[0]) continue;
      taken.add(other);
      found.push({ earlierAddress: address, laterAddress: other, earlier: a.host, later: b.host });
      break;
    }
  }
  return found;
}

/**
 * The earlier run with an origin re-keyed to the later run's key where the two are one article at sister addresses,
 * so the comparison reads them as one origin. Each run's own counts and score are untouched.
 */
function foldSisters(earlier: Side, later: Side, sisters: Sister[]): Side {
  const alias = new Map<string, string>();
  for (const [from, mine] of earlier.originAddresses) {
    if (later.origins.has(from)) continue;
    for (const [to, theirs] of later.originAddresses) {
      if (earlier.origins.has(to) || [...alias.values()].includes(to)) continue;
      if (!sisters.some((pair) => mine.includes(pair.earlierAddress) && theirs.includes(pair.laterAddress))) continue;
      alias.set(from, to);
      break;
    }
  }
  if (!alias.size) return earlier;
  const rekey = <Value extends { key: string }>(entries: Map<string, Value>) => new Map([...entries.values()].map((entry) => { const key = alias.get(entry.key) ?? entry.key; return [key, { ...entry, key }] as const; }));
  return { ...earlier, origins: rekey(earlier.origins), evidenced: rekey(earlier.evidenced) };
}

/** A copy of one run handed in twice (the same claim captured at the same instant) is one run, not two. */
function distinctRuns(runs: readonly SavedRun[]): SavedRun[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    const key = `${run.analysis.createdAt}\n${run.analysis.claim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One record per claim that has two or more saved runs, widest score gap first. Runs are matched with the rule the
 * agent tool, the HTTP route and the command line use (savedMatch in saved-check.ts): the same figures and the same
 * key words, give or take one word. A "check these sources" run reads pasted links and is not a trace of the claim,
 * so it is left out, and so is anything that is not a live run. Pure: the same runs always give the same records.
 */
export function stabilityPairs(runs: readonly SavedRun[]): StabilityPair[] {
  const traced = distinctRuns(runs)
    .filter((run) => run.analysis.mode === "live" && !run.analysis.sourceCheck)
    .sort((a, b) => a.analysis.createdAt.localeCompare(b.analysis.createdAt) || a.file.localeCompare(b.file));
  const groups: SavedRun[][] = [];
  for (const run of traced) {
    const home = groups.find((group) => group.every((member) => savedMatch(run.analysis.claim, [member]) !== null));
    if (home) home.push(run);
    else groups.push([run]);
  }
  return groups
    .filter((group) => group.length > 1)
    .map((group): StabilityPair => {
      const later = sideOf(group[group.length - 1]);
      const first = sideOf(group[0]);
      const sisters = sisterPagesOf(first, later);
      const earlier = foldSisters(first, later, sisters);
      const sisterPages = sisters.map((pair) => ({ earlier: pair.earlier, later: pair.later }));
      return {
        claim: group[group.length - 1].analysis.claim,
        savedRuns: group.length,
        earlier: earlier.run,
        later: later.run,
        gap: Math.abs(later.run.score - earlier.run.score),
        sameDay: earlier.run.day === later.run.day,
        sameRoute: earlier.run.searchedThrough === later.run.searchedThrough,
        sharedPages: [...earlier.addresses.keys()].filter((address) => later.addresses.has(address)).length + sisters.length,
        earlierAddresses: earlier.addresses.size,
        laterAddresses: later.addresses.size,
        sharedOrigins: [...later.origins.values()].filter((origin) => earlier.origins.has(origin.key)),
        onlyEarlier: [...earlier.origins.values()].filter((origin) => !later.origins.has(origin.key)),
        onlyLater: [...later.origins.values()].filter((origin) => !earlier.origins.has(origin.key)),
        counted: { earlier: { withEvidence: earlier.evidenced.size, without: earlier.bare }, later: { withEvidence: later.evidenced.size, without: later.bare } },
        sisterPages,
        why: whyOf(earlier, later),
        sisterNote: sisterPages.length
          ? `${listed(sisterPages.map((pair) => `${pair.earlier} in the earlier run and ${pair.later} in the later`))} ${sisterPages.length === 1 ? "carry one article at two addresses. It is counted once here." : "carry the same articles at two addresses. Each is counted once here."}`
          : null,
      };
    })
    .sort((a, b) => b.gap - a.gap || a.claim.localeCompare(b.claim));
}

/** What a heading may say about the pairs: how many, and the widest and the narrowest gap. Null when there is no pair. */
export interface StabilitySummary {
  claims: number;
  widest: StabilityPair;
  narrowest: StabilityPair;
  /** True when, in every pair, both the day and the search route changed: the pairs cannot say which of the two moved a score. */
  dayAndRouteBothChanged: boolean;
}

export function stabilitySummary(pairs: readonly StabilityPair[]): StabilitySummary | null {
  if (!pairs.length) return null;
  const byGap = [...pairs].sort((a, b) => b.gap - a.gap || a.claim.localeCompare(b.claim));
  return { claims: pairs.length, widest: byGap[0], narrowest: byGap[byGap.length - 1], dayAndRouteBothChanged: pairs.every((pair) => !pair.sameDay && !pair.sameRoute) };
}
