import type { Metadata } from "next";
import Link from "next/link";
import BookmarkletButton from "./bookmarklet-button";
import styles from "./anywhere.module.css";

export const metadata: Metadata = {
  title: "Trace with Echo from any page",
  description: "Select a claim on any web page and open it in Echo in one click. A bookmark, no install.",
};

export default function Anywhere() {
  return (
    <main className={styles.page}>
      <Link className={styles.back} href="/">← Echo</Link>
      <p className={styles.kicker}>TRACE FROM ANYWHERE</p>
      <h1 className={styles.title}>See a claim? Trace it where you read it.</h1>
      <p className={styles.lede}>
        Drag the button to your bookmarks bar. On any article, post or report, select the claim and click the bookmark:
        Echo opens in a new tab with the claim filled in. Nothing runs until you click <b>Trace sources</b>.
      </p>
      <div className={styles.install}>
        <BookmarkletButton className={styles.bookmarklet} />
        <span className={styles.hint}>Drag me to the bookmarks bar</span>
      </div>
      <ol className={styles.steps}>
        <li><b>Select</b> a sentence with the claim, for example “Americans check their phones 96 times a day”.</li>
        <li><b>Click</b> “Trace with Echo” in your bookmarks bar. Nothing selected? It asks you to type the claim.</li>
        <li><b>Trace</b>: Echo shows how many independent origins the claim has, and which pages only repeat it.</li>
      </ol>
      <p className={styles.note}>
        Works in Chrome, Edge, Firefox and Safari on most pages. Some sites block bookmarks that open new tabs; if
        nothing happens, copy the claim and paste it into Echo. The bookmark only sends the selected text, at most 500
        characters, in the address of the Echo tab it opens.
      </p>
      <p className={styles.note}>
        Prefer a right-click menu? Echo&apos;s source includes a browser extension for Chrome, Edge and Brave in its{" "}
        <code>extension/</code> folder: select text, right-click, and choose to trace it. It is not in a web store yet;
        load it unpacked as the README explains. Like the bookmark, it only fills the claim box.
      </p>
    </main>
  );
}
