// Calisthenics set logger — pull-ups / push-ups. Mobile-first, one-handed:
// a scroll-snap rep roller (tap chevrons or flick-scroll to change value) and
// tap-only RIR chips, so a set can be logged without needing both hands free
// mid-workout. React (no build) via htm + esm.sh; Phosphor icons.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import * as Ph from "@phosphor-icons/react";

function I({ name, ...rest }) {
  const C = Ph[name] || Ph.CircleDashed;
  return html`<${C} ...${rest} />`;
}

const MOVEMENTS = [
  { key: "pullup", label: "Pull-ups", icon: "ArrowLineUp" },
  { key: "pushup", label: "Push-ups", icon: "ArrowLineDown" },
];

/* ── rep roller ───────────────────────────────────────────────────────────
   iOS-picker-style vertical wheel: scroll-snap for a quick flick, plus
   chevron buttons stacked above/below for a precise single-finger nudge —
   both drive the same `value`, so either interaction style works one-handed. */
const ROLLER_ITEM_H = 56;
const ROLLER_VISIBLE = 5; // odd, so one item sits dead-center
const ROLLER_PAD_ROWS = Math.floor(ROLLER_VISIBLE / 2);

function RepRoller({ value, onChange, min = 0, max = 40 }) {
  const trackRef = useRef(null);
  const ignoreScroll = useRef(false);
  const settleTimer = useRef(null);
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  // Keep the wheel visually in sync whenever `value` changes, whether that
  // came from the user's own scroll, a chevron tap, or the prescription
  // loading in and setting the initial rep count. Instant (not smooth): a
  // multi-hundred-ms smooth animation left a window where a value change
  // mid-flight (e.g. the prescription arriving right after the initial
  // mount) could redirect the animation while a scroll event from the
  // *first* target was still debounced in flight, snapping the picker back
  // to a stale value. An instant jump has no such window — and it also
  // reads as snappier for a quick one-handed mid-set adjustment.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const target = (value - min) * ROLLER_ITEM_H;
    if (Math.abs(el.scrollTop - target) < 1) return;
    ignoreScroll.current = true;
    el.scrollTo({ top: target, behavior: "auto" });
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      ignoreScroll.current = false;
    }, 120);
  }, [value, min]);

  function handleScroll() {
    if (ignoreScroll.current) return;
    clearTimeout(handleScroll._t);
    handleScroll._t = setTimeout(() => {
      const el = trackRef.current;
      if (!el) return;
      const idx = Math.round(el.scrollTop / ROLLER_ITEM_H);
      const next = Math.max(min, Math.min(max, min + idx));
      if (next !== value) onChange(next);
    }, 90); // fires once scroll-snap has visually settled
  }

  const nudge = (delta) => onChange(Math.max(min, Math.min(max, value + delta)));

  return html`
    <div class="roller">
      <button
        type="button"
        class="roller__btn"
        onClick=${() => nudge(1)}
        aria-label="Increase reps"
      >
        <${I} name="CaretUp" size=${20} weight="bold" />
      </button>
      <div class="roller__window" style=${{ height: `${ROLLER_ITEM_H * ROLLER_VISIBLE}px` }}>
        <div class="roller__highlight" aria-hidden="true"></div>
        <div class="roller__track" ref=${trackRef} onScroll=${handleScroll}>
          <div style=${{ height: `${ROLLER_ITEM_H * ROLLER_PAD_ROWS}px` }}></div>
          ${values.map(
            (v) => html`
              <div
                key=${v}
                class="roller__item ${v === value ? "is-selected" : ""}"
                style=${{ height: `${ROLLER_ITEM_H}px` }}
                onClick=${() => onChange(v)}
              >
                ${v}
              </div>
            `,
          )}
          <div style=${{ height: `${ROLLER_ITEM_H * ROLLER_PAD_ROWS}px` }}></div>
        </div>
      </div>
      <button
        type="button"
        class="roller__btn"
        onClick=${() => nudge(-1)}
        aria-label="Decrease reps"
      >
        <${I} name="CaretDown" size=${20} weight="bold" />
      </button>
      <div class="roller__caption">reps</div>
    </div>
  `;
}

/* ── RIR picker ──────────────────────────────────────────────────────────
   One-tap chips (0-4+) plus a separate AMRAP toggle — a set is either a
   normal RIR-rated set or an AMRAP-to-failure set, never both. */
const RIR_OPTIONS = [0, 1, 2, 3, 4];

function RirPicker({ value, isAmrap, onPick, onToggleAmrap }) {
  return html`
    <div class="rirpicker">
      <div class="rirpicker__label">Reps in reserve</div>
      <div class="chiprow">
        ${RIR_OPTIONS.map(
          (r) => html`
            <button
              key=${r}
              type="button"
              class="chip ${!isAmrap && value === r ? "is-active" : ""}"
              onClick=${() => onPick(r)}
            >
              ${r === 4 ? "4+" : r}
            </button>
          `,
        )}
        <button type="button" class="chip chip--amrap ${isAmrap ? "is-active" : ""}" onClick=${onToggleAmrap}>
          <${I} name="Fire" size=${13} weight="fill" />AMRAP
        </button>
      </div>
      <p class="rirpicker__hint">
        AMRAP = one set to complete failure (can't do another rep). Do it as <strong>set 1</strong>, fresh — every
        1–2 weeks, to recalibrate your targets. Normal sets use RIR the rest of the time.
      </p>
    </div>
  `;
}

/* ── rest timer ──────────────────────────────────────────────────────────
   Counts DOWN to a target so it's a countdown, not a stopwatch — the target
   is deliberately short by default and easy to shorten further (adjustable
   ±15s, remembered per movement) since long rest just invites zoning out
   between sets. When it hits zero the whole screen flashes white a couple
   times and the phone vibrates (if supported), so it's noticeable even if
   you've looked away — the actual point of a rest reminder. */
const REST_TARGET_DEFAULT = 60;
const REST_TARGET_MIN = 15;
const REST_TARGET_MAX = 180;
const REST_TARGET_STEP = 15;

const restTargetKey = (movement) => `calisthenics:rest_target:${movement}`;
function loadRestTarget(movement) {
  try {
    const n = parseInt(localStorage.getItem(restTargetKey(movement)), 10);
    return Number.isFinite(n) && n > 0 ? n : REST_TARGET_DEFAULT;
  } catch {
    return REST_TARGET_DEFAULT;
  }
}
function saveRestTarget(movement, sec) {
  try {
    localStorage.setItem(restTargetKey(movement), String(sec));
  } catch {
    /* private-browsing / storage disabled — target just won't persist */
  }
}

function RestStepper({ targetSec, onAdjust }) {
  return html`
    <div class="resttimer__stepper">
      <button type="button" class="stepbtn" onClick=${() => onAdjust(-REST_TARGET_STEP)} aria-label="Shorter rest target">
        <${I} name="Minus" size=${12} weight="bold" />
      </button>
      <span class="resttimer__target">${targetSec}s target</span>
      <button type="button" class="stepbtn" onClick=${() => onAdjust(REST_TARGET_STEP)} aria-label="Longer rest target">
        <${I} name="Plus" size=${12} weight="bold" />
      </button>
    </div>
  `;
}

function RestTimer({ startedAt, targetSec, onAdjustTarget }) {
  const [, tick] = useState(0);
  const flashedRef = useRef(false);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    flashedRef.current = false;
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const remaining = targetSec - elapsed;
  const done = startedAt != null && remaining <= 0;

  // Fire the attention cues exactly once per rest period, the moment it
  // crosses zero (not on every subsequent render while still at zero).
  useEffect(() => {
    if (!done || flashedRef.current) return;
    flashedRef.current = true;
    setFlashing(true);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    const t = setTimeout(() => setFlashing(false), 900);
    return () => clearTimeout(t);
  }, [done]);

  if (!startedAt) {
    return html`
      <div class="resttimer resttimer--idle">
        <${I} name="Timer" size=${16} weight="bold" />
        <span class="resttimer__idle-label">Rest</span>
        <${RestStepper} targetSec=${targetSec} onAdjust=${onAdjustTarget} />
      </div>
    `;
  }

  const displaySec = Math.max(0, remaining);
  const m = Math.floor(displaySec / 60);
  const s = displaySec % 60;

  return html`
    ${flashing ? html`<div class="restflash" aria-hidden="true"></div>` : null}
    <div class=${`resttimer ${done ? "resttimer--done" : ""}`}>
      <${I} name=${done ? "BellRinging" : "Timer"} size=${16} weight="bold" />
      <span class="resttimer__v">${m}:${String(s).padStart(2, "0")}</span>
      <span class="resttimer__tag">${done ? "ready" : "resting"}</span>
      <${RestStepper} targetSec=${targetSec} onAdjust=${onAdjustTarget} />
    </div>
  `;
}

function PrescriptionCard({ p, doneCount = 0 }) {
  const seq = p.target_sequence || [];
  return html`
    <div class="rxcard">
      ${seq.length
        ? html`
            <div class="rxcard__seq">
              <div class="rxcard__k">Today's sets</div>
              <div class="rxseq">
                ${seq.map(
                  (r, i) => html`
                    <span
                      key=${i}
                      class="rxseq__set ${i < doneCount ? "is-done" : i === doneCount ? "is-next" : ""}"
                      >${r}</span
                    >
                  `,
                )}
              </div>
              ${p.last_sequence
                ? html`<div class="faint rxcard__last">Last session: ${p.last_sequence.join(" · ")}</div>`
                : null}
            </div>
          `
        : null}
      <div class="rxcard__row">
        <div class="rxcard__stat">
          <div class="rxcard__k">Sets</div>
          <div class="rxcard__v">${p.target_sets}</div>
        </div>
        <div class="rxcard__stat">
          <div class="rxcard__k">Top-set target</div>
          <div class="rxcard__v">${p.target_reps}<small>reps</small></div>
        </div>
        <div class="rxcard__stat">
          <div class="rxcard__k">RIR band</div>
          <div class="rxcard__v">${p.rir_target}</div>
        </div>
      </div>
      ${p.amrap_due
        ? html`<div class="callout">
            <${I} name="Fire" size=${16} weight="fill" /><span
              >AMRAP retest due — make your <strong>first</strong> set today a true-failure AMRAP (tap the
              AMRAP chip below) before your normal sets. Recalibrates every target from here.</span
            >
          </div>`
        : null}
      <p class="rxcard__note">${p.note}</p>
      ${p.best_amrap_reps != null
        ? html`<p class="faint">
            Best-ever ${p.best_amrap_reps} reps · floor ${p.floor_reps} reps${p.gap_days != null
              ? ` · ${p.gap_days}d since last session`
              : ""}
          </p>`
        : null}
    </div>
  `;
}

function SetList({ sets, onRemove }) {
  if (!sets.length) return null;
  return html`
    <div class="setlist">
      ${sets.map(
        (s, i) => html`
          <span class="setchip" key=${i}>
            <strong>${s.reps}</strong>${s.is_amrap ? " AMRAP" : html` · RIR ${s.rir}`}
            <button type="button" onClick=${() => onRemove(i)} aria-label="Remove set">
              <${I} name="X" size=${11} weight="bold" />
            </button>
          </span>
        `,
      )}
    </div>
  `;
}

function DoneCard({ result, onLogAnother }) {
  const p = result.prescription;
  return html`
    <div class="rxcard rxcard--done">
      <div class="rxcard__done-head">
        <${I} name="CheckCircle" size=${22} weight="fill" />
        <strong>Session saved</strong>
      </div>
      <p class="faint">
        Next time: ${p.target_sequence ? p.target_sequence.join(" · ") : `top set ~${p.target_reps}`} reps @ RIR
        ${p.rir_target}.
      </p>
      <div class="setup-actions">
        <button type="button" class="btn btn--accent" onClick=${onLogAnother}>
          <${I} name="Plus" size=${16} weight="bold" />Log another
        </button>
        <a class="btn btn--ghost" href="/"><${I} name="House" size=${16} weight="bold" />Home</a>
      </div>
    </div>
  `;
}

function App() {
  const initialMovement = new URLSearchParams(location.search).get("m") === "pushup" ? "pushup" : "pullup";
  const [movement, setMovement] = useState(initialMovement);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [reps, setReps] = useState(8);
  const [rir, setRir] = useState(2);
  const [isAmrap, setIsAmrap] = useState(false);
  const [sets, setSets] = useState([]);
  const [sessionStart, setSessionStart] = useState(null);
  const [restStart, setRestStart] = useState(null);
  const [restTarget, setRestTarget] = useState(() => loadRestTarget(initialMovement));
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState(null);

  function adjustRestTarget(delta) {
    setRestTarget((cur) => {
      const next = Math.max(REST_TARGET_MIN, Math.min(REST_TARGET_MAX, cur + delta));
      saveRestTarget(movement, next);
      return next;
    });
  }

  function loadState() {
    return fetch("/api/calisthenics/state")
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setError(String(e)));
  }
  useEffect(() => {
    loadState();
  }, []);

  // Seed the roller from the per-set prescription: set 1's target before
  // anything is logged, then advance to the next set's target each time a set
  // is logged (or removed). Only fires on those transitions — a mid-set roller
  // adjustment isn't yanked, since sets.length doesn't change until "Log set".
  useEffect(() => {
    if (!data) return;
    const p = data[movement]?.prescription;
    if (!p) return;
    const seq = p.target_sequence;
    if (seq?.length) setReps(seq[Math.min(sets.length, seq.length - 1)]);
    else if (!sets.length) setReps(p.target_reps);
  }, [data, movement, sets.length]);

  function switchMovement(next) {
    if (next === movement) return;
    if (sets.length > 0 && !confirm("Switch movement? This session's unsaved sets will be discarded.")) return;
    setMovement(next);
    setSets([]);
    setRestStart(null);
    setSessionStart(null);
    setDone(null);
    setIsAmrap(false);
    setRestTarget(loadRestTarget(next));
  }

  function logSet() {
    const now = Date.now();
    // The timer has been counting elapsed time since restStart (the previous
    // set's log moment) all along — reuse that as the real rest actually
    // taken, independent of whatever the countdown target was set to.
    const restBeforeSec = restStart ? Math.round((now - restStart) / 1000) : null;
    setSets((s) => [...s, { reps, rir: isAmrap ? null : rir, is_amrap: isAmrap, rest_before_sec: restBeforeSec }]);
    if (!sessionStart) setSessionStart(Math.floor(now / 1000));
    setRestStart(now);
    setIsAmrap(false);
  }

  async function finishSession() {
    setFinishing(true);
    try {
      const res = await fetch("/api/calisthenics/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ movement, started_at: sessionStart, sets }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "save failed");
      setDone(body);
      setSets([]);
      setSessionStart(null);
      setRestStart(null);
      await loadState();
    } catch (e) {
      alert("Couldn't save: " + e.message);
    } finally {
      setFinishing(false);
    }
  }

  const p = data?.[movement]?.prescription;

  return html`
    <div class="wrap wrap--narrow">
      <a class="back" href="/"><${I} name="ArrowLeft" size=${16} weight="bold" />Home</a>
      <div class="hero">
        <div class="hero__icon"><${I} name="Barbell" size=${28} weight="duotone" /></div>
        <div class="hero__title">Log a set</div>
      </div>

      <div class="segctrl">
        ${MOVEMENTS.map(
          (m) => html`
            <button
              key=${m.key}
              type="button"
              class="segctrl__btn ${movement === m.key ? "is-active" : ""}"
              onClick=${() => switchMovement(m.key)}
            >
              <${I} name=${m.icon} size=${16} weight="bold" />${m.label}
            </button>
          `,
        )}
      </div>

      ${error
        ? html`<div class="empty">
            <${I} name="WarningCircle" size=${28} weight="duotone" />
            <p>Failed to load.<br /><span class="faint">${error}</span></p>
          </div>`
        : null}
      ${!data && !error ? html`<div class="skeleton" style=${{ height: "9rem" }}></div>` : null}
      ${p ? html`<${PrescriptionCard} p=${p} doneCount=${sets.length} />` : null}

      ${done
        ? html`<${DoneCard} result=${done} onLogAnother=${() => setDone(null)} />`
        : data
          ? html`
              <div class="logcard">
                <${RepRoller} value=${reps} onChange=${setReps} />
                <${RirPicker}
                  value=${rir}
                  isAmrap=${isAmrap}
                  onPick=${(v) => {
                    setRir(v);
                    setIsAmrap(false);
                  }}
                  onToggleAmrap=${() => setIsAmrap((a) => !a)}
                />
                <button type="button" class="btn btn--accent btn--block" onClick=${logSet}>
                  <${I} name="Plus" size=${18} weight="bold" />Log set ${sets.length + 1}
                </button>
                <${RestTimer} startedAt=${restStart} targetSec=${restTarget} onAdjustTarget=${adjustRestTarget} />
                <${SetList} sets=${sets} onRemove=${(i) => setSets((arr) => arr.filter((_, j) => j !== i))} />
                ${sets.length
                  ? html`<button
                      type="button"
                      class="btn btn--ghost btn--block"
                      onClick=${finishSession}
                      disabled=${finishing}
                    >
                      ${finishing ? "Saving…" : "Finish session"}
                    </button>`
                  : null}
              </div>
            `
          : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`
  <${Ph.IconContext.Provider} value=${{ weight: "regular" }}><${App} /></${Ph.IconContext.Provider}>
`);
