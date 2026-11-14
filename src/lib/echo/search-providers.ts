// Search provider names as Echo shows them (the live wait's routing tags, "How Echo checked this", the search audit).
// No request, key or address here: the client imports it.

const PROVIDER_NAMES: Record<string, string> = {
  exa: "Exa", tavily: "Tavily", brave: "Brave", parallel: "Parallel", perplexity: "Perplexity", you: "You.com",
  linkup: "Linkup", serpapi: "SerpApi", ceramic: "Ceramic", seltz: "Seltz", tinyfish: "TinyFish",
};

/** "exa" → "Exa"; a name Echo does not know is shown as the router sent it. */
export function providerDisplayName(name: string): string {
  return PROVIDER_NAMES[name] ?? name;
}

/** Provider names as Echo stores them: lowercase, short, no spaces. Anything else is dropped. */
export function isProviderName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}

/** Provider tags shown on the live wait's plan: at most this many names, then "+N". */
export const PROVIDER_TAGS_SHOWN = 3;

/** The live wait's tag for a routed variant: "Exa · Tavily · Brave", or "Exa · Parallel · Brave +2" past three. */
export function providerTags(names: string[]): string {
  const shown = names.slice(0, PROVIDER_TAGS_SHOWN).map(providerDisplayName).join(" · ");
  return names.length > PROVIDER_TAGS_SHOWN ? `${shown} +${names.length - PROVIDER_TAGS_SHOWN}` : shown;
}

/** "Exa", "Exa and Brave", "Exa, Tavily and Brave". */
export function providerList(names: string[]): string {
  const shown = names.map(providerDisplayName);
  return shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
