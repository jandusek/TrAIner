// Calisthenics set logger — pull-ups / push-ups. Guided set-by-set flow:
// today's prescribed sets render as slot chips; only the next undone slot is
// selectable, tapping it opens an input sheet (rep roller on mobile, stepper
// on desktop), confirming logs the set, starts the rest countdown, and when
// the countdown ends the next slot's sheet opens itself. Completed slots stay
// tappable to fix a mis-entry (no timer restart on edits). Desktop gets a
// two-column layout instead of the phone-width single column.
// React (no build) via htm + esm.sh; Phosphor icons.
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

/* ── desktop detection ────────────────────────────────────────────────────
   Matches the CSS breakpoint below. Drives which rep input renders (roller
   vs stepper) — layout itself is pure CSS. */
const DESKTOP_MQ = "(min-width: 860px)";
function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_MQ);
    const onChange = (e) => setDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

/* ── rep roller (mobile) ──────────────────────────────────────────────────
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
  // came from the user's own scroll, a chevron tap, or the sheet opening on
  // a new slot's target. Instant (not smooth): a multi-hundred-ms smooth
  // animation left a window where a value change mid-flight could redirect
  // the animation while a scroll event from the *first* target was still
  // debounced in flight, snapping the picker back to a stale value.
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
      <button type="button" class="roller__btn" onClick=${() => nudge(1)} aria-label="Increase reps">
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
      <button type="button" class="roller__btn" onClick=${() => nudge(-1)} aria-label="Decrease reps">
        <${I} name="CaretDown" size=${20} weight="bold" />
      </button>
      <div class="roller__caption">reps</div>
    </div>
  `;
}

/* ── rep stepper (desktop) ────────────────────────────────────────────────
   A flick-wheel is a touch idiom; with a mouse it's just friction. Desktop
   gets a big readout with −/+ buttons instead. */
function RepStepper({ value, onChange, min = 0, max = 40 }) {
  const nudge = (delta) => onChange(Math.max(min, Math.min(max, value + delta)));
  return html`
    <div class="repstep">
      <button type="button" class="repstep__btn" onClick=${() => nudge(-1)} aria-label="Decrease reps">
        <${I} name="Minus" size=${20} weight="bold" />
      </button>
      <div class="repstep__value">
        ${value}
        <span class="repstep__caption">reps</span>
      </div>
      <button type="button" class="repstep__btn" onClick=${() => nudge(1)} aria-label="Increase reps">
        <${I} name="Plus" size=${20} weight="bold" />
      </button>
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
   Counts DOWN to a target (adjustable ±15s, remembered per movement). When
   it hits zero the screen flashes, the phone vibrates (if supported), and —
   the guided-flow part — the next set's input sheet opens itself via
   onComplete. */
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

function RestTimer({ startedAt, targetSec, onAdjustTarget, onComplete }) {
  const [, tick] = useState(0);
  const flashedRef = useRef(false);
  const [flashing, setFlashing] = useState(false);
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    flashedRef.current = false;
    if (!startedAt) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const remaining = targetSec - elapsed;
  const done = startedAt != null && remaining <= 0;

  // Fire the attention cues (and the auto-advance) exactly once per rest
  // period, the moment it crosses zero.
  useEffect(() => {
    if (!done || flashedRef.current) return;
    flashedRef.current = true;
    setFlashing(true);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    completeRef.current?.();
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
  // Fill = time remaining, draining left as rest elapses; snaps full coral
  // at zero ("ready").
  const pct = done ? 100 : Math.max(0, Math.min(100, (remaining / targetSec) * 100));

  return html`
    ${flashing ? html`<div class="restflash" aria-hidden="true"></div>` : null}
    <div class=${`resttimer ${done ? "resttimer--done" : ""}`}>
      <${I} name=${done ? "BellRinging" : "Timer"} size=${16} weight="bold" />
      <span class="resttimer__v">${m}:${String(s).padStart(2, "0")}</span>
      <span class="resttimer__tag">${done ? "ready" : "resting"}</span>
      <${RestStepper} targetSec=${targetSec} onAdjust=${onAdjustTarget} />
      <div class="resttimer__bar" aria-hidden="true">
        <div class="resttimer__bar-fill" style=${{ width: `${pct}%` }}></div>
      </div>
    </div>
  `;
}

/* ── set slots ───────────────────────────────────────────────────────────
   The prescription's per-set targets as a row of slot chips. Done slots show
   what was logged (tap to edit); the next undone slot is the only planned
   one that's tappable; later planned slots wait greyed-out. Once every
   planned slot is done, a "+" slot lets the athlete tack on extra sets. */
function SetSlots({ plan, logged, activeSlot, onSelect }) {
  const next = logged.length;
  const total = Math.max(plan.length, logged.length);
  const slots = [];
  for (let i = 0; i < total; i++) slots.push(i);
  const showAdd = next >= plan.length; // all planned sets done (or no plan)

  return html`
    <div class="slots">
      ${slots.map((i) => {
        const entry = logged[i];
        const isNext = i === next;
        const state = entry ? "is-done" : isNext ? "is-next" : "is-locked";
        const active = activeSlot === i ? "is-active" : "";
        return html`
          <button
            key=${i}
            type="button"
            class="slot ${state} ${active}"
            disabled=${!entry && !isNext}
            onClick=${() => onSelect(i)}
          >
            <span class="slot__num">Set ${i + 1}</span>
            <span class="slot__reps">
              ${entry ? entry.reps : (plan[i] ?? "–")}
            </span>
            <span class="slot__sub">
              ${entry
                ? entry.is_amrap
                  ? html`<${I} name="Fire" size=${10} weight="fill" /> AMRAP`
                  : html`<${I} name="Check" size=${10} weight="bold" /> RIR ${entry.rir}`
                : isNext
                  ? "up next"
                  : "target"}
            </span>
          </button>
        `;
      })}
      ${showAdd
        ? html`
            <button
              type="button"
              class="slot slot--add ${activeSlot === total ? "is-active" : ""}"
              onClick=${() => onSelect(total)}
            >
              <span class="slot__num">extra</span>
              <span class="slot__reps"><${I} name="Plus" size=${18} weight="bold" /></span>
              <span class="slot__sub">add set</span>
            </button>
          `
        : null}
    </div>
  `;
}

/* ── set input sheet ─────────────────────────────────────────────────────
   The modal: bottom sheet on mobile, centered dialog on desktop. Local
   state seeds from the slot's target (new) or its logged values (edit) at
   mount; the sheet is keyed by slot upstream so switching slots remounts. */
function SetSheet({ slot, target, existing, amrapDue, desktop, onConfirm, onClose }) {
  const [reps, setReps] = useState(existing ? existing.reps : target);
  const [rir, setRir] = useState(existing && existing.rir != null ? existing.rir : 2);
  // Nudge the due AMRAP onto a fresh set 1 by preselecting it — still one tap
  // to opt out.
  const [isAmrap, setIsAmrap] = useState(existing ? existing.is_amrap : slot === 0 && amrapDue);

  return html`
    <div class="sheet-backdrop" onClick=${onClose}>
      <div class="sheet" role="dialog" aria-modal="true" onClick=${(e) => e.stopPropagation()}>
        <div class="sheet__head">
          <strong>Set ${slot + 1}</strong>
          <span class="faint">${existing ? "edit what you logged" : `target ${target} reps`}</span>
          <button type="button" class="sheet__close" onClick=${onClose} aria-label="Close">
            <${I} name="X" size=${16} weight="bold" />
          </button>
        </div>
        ${desktop
          ? html`<${RepStepper} value=${reps} onChange=${setReps} />`
          : html`<${RepRoller} value=${reps} onChange=${setReps} />`}
        <${RirPicker}
          value=${rir}
          isAmrap=${isAmrap}
          onPick=${(v) => {
            setRir(v);
            setIsAmrap(false);
          }}
          onToggleAmrap=${() => setIsAmrap((a) => !a)}
        />
        <button
          type="button"
          class="btn btn--accent btn--block"
          onClick=${() => onConfirm({ reps, rir: isAmrap ? null : rir, is_amrap: isAmrap })}
        >
          <${I} name="Check" size=${18} weight="bold" />${existing ? "Save changes" : `Log set ${slot + 1}`}
        </button>
      </div>
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

/* Quiet context under the working surface: why today's targets are what they
   are. The targets themselves live in the slot chips — no stats row here, it
   would just repeat them. */
function ContextCard({ p }) {
  return html`
    <div class="rxcard rxcard--context">
      <p class="rxcard__note">${p.note}</p>
      ${p.last_sequence
        ? html`<p class="faint rxcard__last">Last session: ${p.last_sequence.join(" · ")}</p>`
        : null}
      ${p.best_amrap_reps != null
        ? html`<p class="faint">
            Best-ever ${p.best_amrap_reps} reps · floor ${p.floor_reps} reps · RIR ${p.rir_target}${p.gap_days !=
            null
              ? ` · ${p.gap_days}d since last session`
              : ""}
          </p>`
        : null}
    </div>
  `;
}

function App() {
  const initialMovement = new URLSearchParams(location.search).get("m") === "pushup" ? "pushup" : "pullup";
  const desktop = useDesktop();
  const [movement, setMovement] = useState(initialMovement);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sets, setSets] = useState([]); // slot-indexed logged entries
  const [activeSlot, setActiveSlot] = useState(null);
  const [sessionStart, setSessionStart] = useState(null);
  const [restStart, setRestStart] = useState(null);
  const [restTarget, setRestTarget] = useState(() => loadRestTarget(initialMovement));
  const [finishing, setFinishing] = useState(false);
  const [done, setDone] = useState(null);

  const p = data?.[movement]?.prescription;
  const plan = p?.target_sequence ?? [];
  const nextSlot = sets.length;
  const planComplete = plan.length > 0 && nextSlot >= plan.length;

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

  function switchMovement(next) {
    if (next === movement) return;
    if (sets.length > 0 && !confirm("Switch movement? This session's unsaved sets will be discarded.")) return;
    setMovement(next);
    setSets([]);
    setActiveSlot(null);
    setRestStart(null);
    setSessionStart(null);
    setDone(null);
    setRestTarget(loadRestTarget(next));
  }

  function confirmSet(slot, entry) {
    const now = Date.now();
    const isNew = slot === sets.length;
    setSets((prev) => {
      const cp = [...prev];
      cp[slot] = {
        ...entry,
        // The countdown has been measuring elapsed time since the previous
        // set was logged — reuse that as the real rest taken. Edits keep the
        // rest that was recorded when the set was first logged.
        rest_before_sec: isNew
          ? restStart
            ? Math.round((now - restStart) / 1000)
            : null
          : (prev[slot]?.rest_before_sec ?? null),
      };
      return cp;
    });
    if (!sessionStart) setSessionStart(Math.floor(now / 1000));
    setActiveSlot(null);
    // Timer runs only after logging the latest set with planned sets still
    // to go — never on an edit, never after the final planned set. restStart
    // still updates on every new set so extra sets get a real rest_before.
    if (isNew) setRestStart(now);
  }

  // Rest countdown finished → auto-open the next planned slot's sheet, unless
  // the athlete is mid-edit in some sheet already.
  function onRestComplete() {
    setActiveSlot((cur) => {
      if (cur != null) return cur;
      return sets.length < plan.length ? sets.length : cur;
    });
  }

  async function finishSession() {
    setFinishing(true);
    try {
      const res = await fetch("/api/calisthenics/log", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ movement, started_at: sessionStart, sets: sets.filter(Boolean) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || "save failed");
      setDone(body);
      setSets([]);
      setActiveSlot(null);
      setSessionStart(null);
      setRestStart(null);
      await loadState();
    } catch (e) {
      alert("Couldn't save: " + e.message);
    } finally {
      setFinishing(false);
    }
  }

  const showTimer = restStart != null && !planComplete && sets.length > 0;
  const sheetTarget =
    activeSlot != null ? (plan[activeSlot] ?? sets[activeSlot]?.reps ?? sets[nextSlot - 1]?.reps ?? 8) : null;

  return html`
    <div class="wrap wrap--cal">
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

      ${done
        ? html`<${DoneCard} result=${done} onLogAnother=${() => setDone(null)} />`
        : data
          ? html`
              <div class="calgrid">
                <div class="calgrid__log logcard">
                  ${p?.amrap_due
                    ? html`<div class="callout">
                        <${I} name="Fire" size=${16} weight="fill" /><span
                          >AMRAP retest due — make <strong>set 1</strong> a true-failure AMRAP (preselected in
                          its sheet). Recalibrates every target from here.</span
                        >
                      </div>`
                    : null}
                  <${SetSlots}
                    plan=${plan}
                    logged=${sets}
                    activeSlot=${activeSlot}
                    onSelect=${setActiveSlot}
                  />
                  ${showTimer
                    ? html`<${RestTimer}
                        startedAt=${restStart}
                        targetSec=${restTarget}
                        onAdjustTarget=${adjustRestTarget}
                        onComplete=${onRestComplete}
                      />`
                    : html`<div class="resttimer resttimer--idle">
                        <${I} name="Timer" size=${16} weight="bold" />
                        <span class="resttimer__idle-label">Rest</span>
                        <${RestStepper} targetSec=${restTarget} onAdjust=${adjustRestTarget} />
                      </div>`}
                  ${sets.length
                    ? html`<button
                        type="button"
                        class="btn ${planComplete ? "btn--accent" : "btn--ghost"} btn--block"
                        onClick=${finishSession}
                        disabled=${finishing}
                      >
                        ${finishing
                          ? "Saving…"
                          : planComplete
                            ? "Finish session"
                            : `Finish early (${sets.length}/${plan.length || sets.length} sets)`}
                      </button>`
                    : null}
                </div>
                <div class="calgrid__info">${p ? html`<${ContextCard} p=${p} />` : null}</div>
              </div>
            `
          : null}
      ${activeSlot != null && data
        ? html`<${SetSheet}
            key=${activeSlot}
            slot=${activeSlot}
            target=${sheetTarget}
            existing=${sets[activeSlot] ?? null}
            amrapDue=${Boolean(p?.amrap_due)}
            desktop=${desktop}
            onConfirm=${(entry) => confirmSet(activeSlot, entry)}
            onClose=${() => setActiveSlot(null)}
          />`
        : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`
  <${Ph.IconContext.Provider} value=${{ weight: "regular" }}><${App} /></${Ph.IconContext.Provider}>
`);
