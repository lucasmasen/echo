import { NO_EVIDENCE_WEIGHT, ORIGIN_TYPE_WEIGHTS, SCORE_SCALE, scoreLabel, type OriginLayer, type OriginType, type ScoreLabel } from "./origin-layer";

// "Echo went looking": what Echo saved after one more search for a name most origins share (upstream.ts finds the
// name; pipeline.ts findUpstream runs the search and one model call; scripts/origin-upstream.mjs saves the record).
// This file is the arithmetic only: given a run's origin layer and a saved record, which origins fold into the
// document they cite, and what the count and the score become. Pure: no network, no model call.

export type UpstreamCites = "yes" | "no" | "unclear";

/**
 * The search Echo sends for a shared name: the name (up to three), the claim's own words, and words that seek the
 * document itself. `wide` is the second try, without those words. Pure: it builds a string and sends nothing.
 */
export function upstreamQuery(claim: string, names: string[], wide = false): string {
  const quoted = (name: string) => (/\s/.test(name) ? `"${name}"` : name);
  const core = claim.replace(/[“”"]/g, "").replace(/[.!?]+$/, "").trim();
  const lead = names.slice(0, 3).map(quoted).join(" ");
  const query = (wide ? `${lead} ${core}` : `${lead} ${core} original report OR study OR book OR paper`).trim();
  return query.length <= 390 ? query : `${query.slice(0, 387).replace(/\s+\S*$/, "").trim()}…`;
}

export interface UpstreamRecord {
  version: 1;
  claim: string;
  /** createdAt of the trace this was measured on. */
  traceCreatedAt: string;
  /** The shared name Echo searched for (the first name the rule found), and every name the rule found. */
  name: string;
  names: string[];
  /** The search Echo sent through Telem (and a second one, only when the first returned nothing usable). */
  query: string;
  queries: string[];
  /** The engines that answered, as Telem reported them. */
  engines: string[];
  /** The pages Echo showed the model: found by that search and not already pages of the run. */
  candidates: Array<{ title: string; url: string; domain: string }>;
  /** The candidate the model said IS the named document or its own official page. Null when none was. */
  upstream: { title: string; url: string; domain: string; date: string | null; type: OriginType } | null;
  /** True when the model said that page shows the claim's figure or finding itself (not only talk about it). */
  upstreamShowsFigure: boolean;
  upstreamReason: string;
  /**
   * Each origin of the run: does its saved passage attribute the claim to that document (cites), and does it also
   * report evidence of its own that does not come from the document (independent)? Both are the model's answers.
   */
  origins: Array<{ id: string; name: string; cites: UpstreamCites; independent: boolean; reason: string }>;
  model: string;
  /** Search plus model call, list-price estimate from the run's own receipt. */
  usd: number;
  createdAt: string;
}

export interface FoldSide {
  origins: number;
  publishers: number;
  score: number;
  label: ScoreLabel;
}

export interface UpstreamFold {
  before: FoldSide;
  after: FoldSide;
  /** Origins whose passage rests the claim on the document and brings no evidence of its own: counted as copies of it. */
  folded: string[];
  /** Origins left as they were: "no", "unclear", and those that cite the document but bring evidence of their own. */
  kept: string[];
  /** Of the kept ones, those that cite the document and still stand on evidence of their own. */
  citesButStands: string[];
  upstreamFound: boolean;
  /** True when the document is counted as one origin after the fold (something folded into it, or Echo found its page). */
  upstreamCounted: boolean;
  /** What each origin adds to the score after the fold, in the order counted; they sum to weightSum. */
  weights: Array<{ name: string; weight: number }>;
  weightSum: number;
}

/**
 * Fold the origins that rest on the document into it. An origin with cites "yes" and no evidence of its own becomes
 * a copy (it adds nothing). "no", "unclear" and an origin that cites the document but reports evidence that does not
 * come from it stay as they are, one count per publisher as in the origin layer. The document itself counts as
 * one origin: its type's weight when Echo found its page and the model said the page shows the figure itself,
 * otherwise the no-evidence weight (a page that does not show it, or a document Echo did not retrieve).
 */
export function foldUpstream(layer: Pick<OriginLayer, "origins" | "entities" | "score" | "label">, record: Pick<UpstreamRecord, "origins" | "upstream" | "upstreamShowsFigure" | "name">): UpstreamFold {
  const before: FoldSide = { origins: layer.origins.length, publishers: layer.entities, score: layer.score, label: layer.label };
  const verdictOf = new Map(record.origins.map((entry) => [entry.id, entry] as const));
  const folds = (id: string) => verdictOf.get(id)?.cites === "yes" && verdictOf.get(id)?.independent !== true;
  const foldedOrigins = layer.origins.filter((origin) => folds(origin.id));
  const keptOrigins = layer.origins.filter((origin) => !folds(origin.id));
  // One count per publisher among the origins that stay: the one the layer counted, else the first that is left.
  const byEntity = new Map<string, (typeof keptOrigins)[number]>();
  for (const origin of keptOrigins) {
    const held = byEntity.get(origin.entity);
    if (!held || (origin.counted && !held.counted)) byEntity.set(origin.entity, origin);
  }
  const weights = [...byEntity.values()].map((origin) => ({ name: origin.name, weight: origin.ownEvidence ? ORIGIN_TYPE_WEIGHTS[origin.type] : NO_EVIDENCE_WEIGHT }));
  const upstreamFound = record.upstream !== null;
  const upstreamCounted = upstreamFound || foldedOrigins.length > 0;
  if (upstreamCounted) {
    const type: OriginType = record.upstream && record.upstream.type in ORIGIN_TYPE_WEIGHTS ? record.upstream.type : "unknown";
    weights.push({ name: record.upstream?.domain ?? record.name, weight: upstreamFound && record.upstreamShowsFigure ? ORIGIN_TYPE_WEIGHTS[type] : NO_EVIDENCE_WEIGHT });
  }
  const weightSum = weights.reduce((sum, entry) => sum + entry.weight, 0);
  const score = Math.round(100 * (1 - Math.exp(-weightSum / SCORE_SCALE)));
  const after: FoldSide = {
    origins: keptOrigins.length + (upstreamCounted ? 1 : 0),
    publishers: byEntity.size + (upstreamCounted ? 1 : 0),
    score,
    label: scoreLabel(score),
  };
  return { before, after, folded: foldedOrigins.map((origin) => origin.name), kept: keptOrigins.map((origin) => origin.name), citesButStands: keptOrigins.filter((origin) => verdictOf.get(origin.id)?.cites === "yes").map((origin) => origin.name), upstreamFound, upstreamCounted, weights, weightSum: Math.round(weightSum * 100) / 100 };
}
