"use client";

import { useEffect, useRef } from "react";
import { bookmarkletHref } from "@/lib/echo/bookmarklet";

// React refuses javascript: URLs in markup, so the bookmark's address is set on the element after it mounts, for the
// origin this page is served from. Clicking it here (instead of dragging) just explains what to do.
export default function BookmarkletButton({ className }: { className?: string }) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.setAttribute("href", bookmarkletHref(window.location.origin));
  }, []);
  return (
    <a
      className={className}
      onClick={(event) => {
        event.preventDefault();
        window.alert("Drag this button to your bookmarks bar, then click it on any page after selecting a claim.");
      }}
      ref={link}
      title="Drag to your bookmarks bar"
    >
      Trace with Echo
    </a>
  );
}
