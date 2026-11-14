"use client";

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import styles from "./pitch.module.css";

export interface PitchSlide {
  key: string;
  /** A short name for the slide, read out with its position. */
  label: string;
  node: ReactNode;
}

/** Controls a click or a key should reach on their own, without also turning the slide. */
const CONTROLS = "button, a, input, textarea, select, summary";

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

/**
 * The slides, one on screen at a time. Right arrow, Space or a click goes on; Left arrow goes back; F is full screen.
 * It reads no address, sends no request and stores nothing: the slides arrive already drawn from the saved runs.
 */
export default function PitchDeck({ slides }: { slides: PitchSlide[] }) {
  const [index, setIndex] = useState(0);
  const last = Math.max(0, slides.length - 1);
  const step = useCallback((by: number) => setIndex((at) => Math.max(0, Math.min(last, at + by))), [last]);
  const jump = useCallback((to: number) => setIndex(Math.max(0, Math.min(last, to))), [last]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const onControl = event.target instanceof Element && Boolean(event.target.closest(CONTROLS));
      const key = event.key;
      if (key === "ArrowRight" || key === "PageDown") step(1);
      else if (key === "ArrowLeft" || key === "PageUp") step(-1);
      else if (key === " " || key === "Enter") {
        // On a focused button, Space and Enter press that button and nothing else.
        if (onControl) return;
        step(1);
      } else if (key === "Home") jump(0);
      else if (key === "End") jump(last);
      else if (key === "f" || key === "F") toggleFullscreen();
      else if (/^[1-9]$/.test(key) && Number(key) <= last + 1) jump(Number(key) - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, jump, last]);

  if (!slides.length) return null;
  const at = Math.min(index, last);
  const slide = slides[at];
  // A pressed control drops focus, so the next Space turns the slide and does not press the control again.
  const press = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
    action();
    event.currentTarget.blur();
  };
  return (
    <div className={styles.deck}>
      <div
        className={styles.stage}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest(CONTROLS)) return;
          step(1);
        }}
      >
        <section aria-label={`Slide ${at + 1} of ${slides.length}: ${slide.label}`} aria-live="polite" aria-roledescription="slide" className={styles.slide} key={slide.key}>
          {slide.node}
        </section>
      </div>
      <div aria-hidden="true" className={styles.progress}>
        <span className={styles.progressFill} style={{ width: `${((at + 1) / slides.length) * 100}%` }} />
      </div>
      <div className={styles.bar}>
        <span className={styles.brand}>Echo<span className={styles.brandDot}>.</span></span>
        <span className={styles.barNote}>Saved runs. This page sends no search and no model request.</span>
        <div className={styles.controls}>
          <button aria-label="Previous slide" className={styles.control} disabled={at === 0} onClick={press(() => step(-1))} title="Left arrow" type="button">←</button>
          <span aria-label={`Slide ${at + 1} of ${slides.length}`} className={styles.counter}>{at + 1} / {slides.length}</span>
          <button aria-label="Next slide" className={styles.control} disabled={at === last} onClick={press(() => step(1))} title="Right arrow or Space" type="button">→</button>
          <button className={styles.control} onClick={press(toggleFullscreen)} title="Press F" type="button">Full screen</button>
        </div>
      </div>
    </div>
  );
}
