# Evaluating Echo's source judgments

This is an **offline human-review workflow**, not an automatic fact checker. It compares Echo's saved tree with labels a reviewer supplies after opening the original pages. Synthetic rehearsal fixtures are useful for checking the command, not for reporting product accuracy.

## Make and score a label sheet

1. Save a live trace from Echo as a `.echo.json` file.
2. Create a label sheet: `npm run eval:trace -- init path/to/trace.echo.json path/to/labels.json`. Notes saved on pages in the trace are copied into `note`; expected classifications remain blank.
3. Open each source URL in the sheet. Fill `expectedKind` with `origin`, `derived`, or `unclear`; leave it `null` until reviewed. For `derived`, set `expectedParentKey` to an **earlier sourceKey already in this sheet**. For other kinds, keep `expectedParentKey: null`. Put the concrete reason in `note`.
4. Run `npm run eval:trace -- score path/to/trace.echo.json path/to/labels.json`. Add `--json` for machine-readable results.
5. Score a later trace for the same claim against the same sheet. Pages are matched by normalized URL (or title/domain when no URL exists), so regenerated page IDs do not count as different sources. The command reports labeled sources absent from the later trace separately.

`init` refuses to overwrite an existing label file. Keep manually reviewed sheets under version control only if their contents are meant to be shared; they can contain source URLs and review notes. The command reads local files and makes no provider calls.

## Labeling rules

- **Origin:** Within the pages retrieved for this claim, this page presents an independent report, firsthand record, or inspectable data, and no earlier source in this set is supported as its parent. This is a candidate root of the **retrieved set**, not proof of the first source anywhere on the web.
- **Derived:** The page materially repeats an earlier page and the direction is supported by publication dates plus a citation, distinctive shared wording, shared unusual details, or other concrete source evidence. Record the best-supported earlier page as `expectedParentKey`.
- **Derived by citation:** If a page has no reliable date but explicitly cites an earlier-dated page in the sheet (a link, that page's distinctive title, or its organization's name with its publication year), label it `derived` from that page: a page cannot cite something published after it. Quote the citation in `note`.
- **Unclear:** The source relationship or direction cannot be established. Use this for missing or merely search-estimated dates, an inaccessible full page, ambiguous syndication, or similar wording without a supported parent. Do not force a binary label to improve the score.

For every decisive root or edge, open the original page. Check whether its visible date is a publication date or an update date. Tavily search dates may be later updates. A search snippet is incomplete. Record uncertainty in the note rather than treating missing text as proof of no evidence.

## What to include in the small evaluation set

Aim for 6–10 manually checked **cases** across several claims: direct quotation or linked reuse, paraphrased dependence, genuinely independent reporting about the same claim, missing date, reversed date, snippet-only extraction, fact-check retelling, and a wire or press-release syndication example. Keep an example only when the reviewer can explain the expected relationship from the pages. Do not label a famous origin story from memory.

## Reading the score

- **Kind accuracy:** exact `origin` / `derived` / `unclear` agreement on reviewed pages also present in the scored trace.
- **Derived precision / recall:** whether Echo marks the reviewed derived pages as derived. The parent can still be wrong; inspect **exact parent links** separately.
- **Settled mistakes:** Echo chose `origin` or `derived` where the reviewed label differs. These are more concerning than an abstention.
- **Abstentions:** Echo said `unclear` where a reviewer could establish `origin` or `derived`. These reduce coverage but avoid a firm unsupported edge.
- **Missing labeled sources:** reviewed pages absent from the scored trace. They are excluded from accuracy denominators and reveal retrieval instability.

With a small set, report the raw counts and examples alongside percentages. Agreement with manual labels is not a measure of web-wide source coverage or factual truth. Echo's current claim candidates have not yet passed this evaluation.
