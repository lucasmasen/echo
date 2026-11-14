// Preloaded (node --import) into the smoke test's second `next start` server only. It answers Tavily and Anthropic
// with canned data, so the UI can be driven through a complete live run of a judge-typed claim with no network and
// no spend. Every other outside address fails, as if offline. Never loaded by the app itself.
import fs from "node:fs";

const urls = ["https://origin.example/startup-study", "https://repeat.example/startups-fail", "https://coffee.example/founders"];
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const model = (value) => json({ content: [{ type: "text", text: JSON.stringify(value) }], usage: { input_tokens: 100, output_tokens: 50 } });

function provider(url, init) {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url.endsWith("/search")) return json({ results: [
    { url: urls[0], title: "Startup study: 90% of startups fail", content: "Our dataset of 2,000 startups shows 90% of startups fail within ten years.", published_date: "2019-03-01", score: 0.9 },
    { url: urls[1], title: "Why 90% of startups fail", content: "90% of startups fail, according to the 2019 startup study.", published_date: "2021-06-01", score: 0.8 },
    { url: urls[2], title: "90% of startup founders prefer coffee", content: "90% of startup founders prefer coffee.", published_date: "2022-01-01", score: 0.7 },
  ], usage: { credits: 1 } });
  if (url.endsWith("/extract")) return json({ results: [
    { url: urls[0], raw_content: "Published: 2019-03-01. Our dataset of 2,000 startups shows 90% of startups fail within ten years. Methods: we followed every company for ten years." },
    { url: urls[1], raw_content: `Published: 2021-06-01. 90% of startups fail, according to the 2019 startup study. Source: ${urls[0]}` },
    { url: urls[2], raw_content: "Published: 2022-01-01. 90% of startup founders prefer coffee." },
  ], usage: { credits: 1 } });
  if (url.endsWith("/count_tokens")) return json({ input_tokens: 100 });
  if (url.endsWith("/messages")) {
    const prompt = String(body.messages?.[0]?.content ?? "");
    // A claim naming "smoke overload" finds Claude overloaded on every call, so the error banner can be tested.
    if (/smoke overload/i.test(prompt)) return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529, headers: { "retry-after": "1" } });
    if (prompt.startsWith("Group these")) return model({ clusters: [
      { label: "90% of startups fail", pageIds: ["page-1", "page-2"], matchesClaim: true },
      { label: "Founders and coffee", pageIds: ["page-3"], matchesClaim: false },
    ] });
    if (prompt.startsWith("You are a cautious")) return model({ judgements: [
      { pageId: "page-1", kind: "origin", parentId: null, confidence: 85, evidence: "Publishes its own ten-year dataset.", hasPrimaryEvidence: true, primaryEvidenceReason: "Describes its dataset and method.", originType: "firsthand" },
      { pageId: "page-2", kind: "derived", parentId: "page-1", confidence: 85, evidence: "Credits the 2019 study and links it.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the figure." },
    ] });
    // The answer step waits 4 s, so the smoke test can see the loading card's elapsed-time clock mid-run.
    // A claim naming "smoke slow" waits 15 s, so the smoke test can grow the progress card mid-run.
    if (prompt.startsWith("Answer the")) return new Promise((resolve) => setTimeout(resolve, /smoke slow/i.test(prompt) ? 15_000 : 4_000)).then(() => model({ claims: [{ text: "A 2019 ten-year dataset of 2,000 startups found that 90% failed.", sourceNumbers: [1] }] }));
    return new Response("smoke mock: unexpected model prompt", { status: 500 });
  }
  return new Response("smoke mock: unexpected provider endpoint", { status: 500 });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.tavily.com/") || url.startsWith("https://api.anthropic.com/")) return provider(url, init);
  // "Trace an article": a canned article page. Its host does not resolve, so Echo's page reader hands it to fetch.
  if (url.startsWith("https://article.echo-smoke.example/")) return new Response(`<html><head><title>Phones &amp; us</title><script>var x = "A fake study found 500 checks a day.";</script></head><body><nav>Subscribe now</nav><article><h1>Phones and us</h1><p>Americans check their phones 96 times a day, according to a 2019 survey by Asurion. That is a lot of checking for anyone to do. Researchers at Stanford found that 1 in 5 teens feel anxious without their phone. Some people simply enjoy the weather outside.</p></article></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  throw new TypeError(`smoke mock: no network for ${url}`);
};
if (process.env.ECHO_SMOKE_MOCK_MARKER) fs.writeFileSync(process.env.ECHO_SMOKE_MOCK_MARKER, String(process.pid));
