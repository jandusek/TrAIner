// Home page — workout logbook. React (no build) via htm + esm.sh; Phosphor icons.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { html } from "htm/react";
import * as Ph from "@phosphor-icons/react";

const BOOT = JSON.parse(document.getElementById("bootstrap").textContent);


/* ── HDR chrome ────────────────────────────────────────────────────────────
   CSS colour is gamut-mapped into SDR — it cannot exceed paper white. Only
   real HDR *content* can, and of the content types only video actually gets
   headroom (HDR PNGs were tested on-device and do not). So the brand gradient
   is shipped as a 717-byte Rec.2020 PQ video, peaking at 500 nits, and the
   elements that glow each mount their own copy.

   Rendered as JSX rather than injected into the DOM: React owns these
   subtrees, and a node appended by hand would be discarded on the next
   re-render (the active pill re-renders on every filter click).

   ui.css gates all of it behind `@media (dynamic-range: high)` — on an SDR
   display the videos never render and the CSS gradients stand unchanged. */
const themeKey = () => document.documentElement.dataset.theme || "illuminate";
/* Peak luminance is user-set; "off" is handled in CSS so the element stays
   mounted and toggling costs nothing. */
const hdrNits = () => {
  const v = document.documentElement.dataset.hdr;
  return v && v !== "off" ? v : "500";
};
/* One asset per nit level, shared by every theme — the colour comes from
   .glow-tint in CSS, not from the video. */
const glowSrc = (nits) => {
  const k = `white@${nits || hdrNits()}`;
  return `/glow/${encodeURIComponent(k)}.webm?v=${(window.__GLOW_VER || {})[k] || ""}`;
};

function HdrGlow({ className, nits }) {
  return html`<span class=${`hdrglow ${className}`}>
    <video
      class="hdrglow-vid"
      src=${glowSrc(nits)}
      autoPlay
      muted
      loop
      playsInline
      aria-hidden="true"
    />
    <span class="hdrglow-tint"></span>
  </span>`;
}

/* The "AI" glows by masking the same video to a text shape. The mask is drawn
   on a canvas using the element's own resolved font — an SVG <text> mask would
   render in a fallback face, because an SVG mask cannot see the page's
   webfonts, and would sit misaligned over the real glyphs. */
function useAiMask(nameRef, aiRef, layerRef) {
  useEffect(() => {
    function build() {
      const name = nameRef.current, ai = aiRef.current, layer = layerRef.current;
      if (!name || !ai || !layer) return;
      const cs = getComputedStyle(name);
      // Fractional box, not offsetWidth/Height: those round to integers, which
      // would stretch the mask against the real layout box.
      const nb = name.getBoundingClientRect();
      const ab = ai.getBoundingClientRect();
      const w = nb.width, h = nb.height;
      if (!w || !h) return;

      // Both axes are MEASURED, not derived. Deriving the baseline by centring
      // the font's bounding box in the line box is only an approximation of
      // how a browser lays out a line, and it drifts whenever a font's
      // reported ascent/descent differ from the metrics used for layout —
      // which is what pushed the "AI" off the baseline of the word around it.
      // A zero-height inline-block sits exactly on the baseline, so the DOM
      // can just be asked where it is.
      const probe = document.createElement("span");
      probe.style.cssText =
        "display:inline-block;width:0;height:0;vertical-align:baseline";
      name.appendChild(probe);
      const baseline = probe.getBoundingClientRect().top - nb.top;
      probe.remove();
      // x likewise comes from the span's own rect rather than from
      // measureText("Tr"), so kerning and letter-spacing cannot disagree.
      const x = ab.left - nb.left;

      // The glyph becomes an alpha bitmap, not text, so it can never match the
      // hinted, subpixel-antialiased "Tr"/"ner" beside it — but it can get
      // close. The mask is supersampled well past device pixels; the element
      // is ~80x21 CSS px, so even 8x is a trivial canvas (~640x170).
      const S = Math.min(8, (window.devicePixelRatio || 1) * 4);
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(w * S); cv.height = Math.ceil(h * S);
      const c = cv.getContext("2d");
      c.scale(S, S);
      c.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if ("letterSpacing" in c) c.letterSpacing = cs.letterSpacing;
      c.textBaseline = "alphabetic";
      c.fillStyle = "#fff";
      c.fillText("AI", x, baseline);
      const url = `url("${cv.toDataURL("image/png")}")`;
      layer.style.webkitMaskImage = url; layer.style.maskImage = url;
      layer.style.webkitMaskRepeat = layer.style.maskRepeat = "no-repeat";
      // exact canvas-pixel mapping — "100% 100%" would rescale by the ceil()
      layer.style.webkitMaskSize = layer.style.maskSize =
        `${cv.width / S}px ${cv.height / S}px`;
      layer.style.webkitMaskPosition = layer.style.maskPosition = "0 0";
      ai.classList.add("is-hdr");
    }
    build();
    addEventListener("resize", build);
    // a webfont landing after first paint would leave a stale mask
    if (document.fonts?.ready) document.fonts.ready.then(build);
    return () => removeEventListener("resize", build);
  }, []);
}

/* ── icon helpers ─────────────────────────────────────────────────────────── */
// Resolve Phosphor icons by name with a graceful fallback so a wrong name never
// blanks the whole app.
function I({ name, ...rest }) {
  const C = Ph[name] || Ph.CircleDashed;
  return html`<${C} ...${rest} />`;
}
const SPORT_ICON = {
  swimming: "PersonSimpleSwim",
  cycling: "PersonSimpleBike",
  tennis: "TennisBall",
  running: "PersonSimpleRun",
  calisthenics: "Barbell",
};
const sportIcon = (s) => SPORT_ICON[s] || "Barbell";
const SPORT_LABEL = {
  swimming: "Swim",
  cycling: "Cycling",
  tennis: "Tennis",
  running: "Running",
  calisthenics: "Calisthenics",
  other: "Other",
};
const sportLabel = (s) => SPORT_LABEL[s] || s;

const PAGE_SIZE = 20;

/* ── formatting ───────────────────────────────────────────────────────────── */
const pad = (n) => String(n).padStart(2, "0");
function fmtWhen(epoch, offset) {
  const offMin = offset
    ? (offset[0] === "-" ? -1 : 1) *
      (parseInt(offset.slice(1, 3)) * 60 + parseInt(offset.slice(3, 5)))
    : 0;
  const d = new Date((epoch + offMin * 60) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mons = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${days[d.getUTCDay()]} ${d.getUTCDate()} ${mons[d.getUTCMonth()]} · ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtDur(s) {
  if (s == null) return "—";
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.round(s % 60);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function fmtDist(m) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
const round = (v) => (v == null ? null : Math.round(v));

/* ── components ───────────────────────────────────────────────────────────── */
function Metric({ k, v, sub, tip }) {
  if (v == null || v === "") return null;
  return html`<span class="metric" title=${tip || undefined}
    ><span class="metric__k">${k}</span
    ><span class="metric__v"
      >${v}${sub ? html`<span class="metric__sub">${sub}</span>` : null}</span
    ></span
  >`;
}

// Effort % — this session's RIR-adjusted top set vs. the best the athlete had
// shown *going into* it (see calisthenics.ts's summarizeSessions). Self-
// referential by design: 100% means "matched your own best so far," not some
// fixed rep count, so it's reachable from day one and stays meaningful as
// capability grows. Colored so a run of cards reads at a glance.
function EffortMetric({ pct }) {
  if (pct == null) return null;
  const kind = pct >= 100 ? "good" : pct >= 80 ? "ok" : "low";
  return html`<span class="metric"
    ><span class="metric__k">effort</span
    ><span class=${`metric__v metric__v--${kind}`}>${pct}%</span></span
  >`;
}

function Card({ w, index }) {
  const dist = fmtDist(w.distance_m);
  const isSwim = w.sport === "swimming";
  const isCalisthenics = w.sport === "calisthenics";
  return html`
    <a
      class="card rise"
      style=${{ animationDelay: `${index * 45}ms` }}
      href=${`/w/${encodeURIComponent(w.source_id)}`}
    >
      <div class="card__icon">
        <${I} name=${sportIcon(w.sport)} size=${26} weight="duotone" />
      </div>
      <div class="card__title">${w.sub_type || w.sport}</div>
      <div class="card__badges">
        ${w.has_eval
          ? html`<span class="badge badge--eval"
              ><${I} name="Sparkle" size=${11} weight="fill" />Eval</span
            >`
          : null}
        ${w.sets_focus
          ? html`<span class="badge badge--focus"
              ><${I} name="Target" size=${11} weight="bold" />Focus</span
            >`
          : null}
        ${w.has_note
          ? html`<span class="badge badge--note"
              ><${I} name="NotePencil" size=${11} weight="bold" />Notes</span
            >`
          : null}
      </div>
      <div class="card__when">${fmtWhen(w.start_time, w.tz_offset)}</div>
      <div class="card__stats">
        ${w.moving_sec != null && w.duration_sec - w.moving_sec >= 30
          ? html`<${Metric}
              k="time"
              v=${fmtDur(w.moving_sec)}
              sub=${` / ${fmtDur(w.duration_sec)}`}
              tip=${`${fmtDur(w.moving_sec)} moving, ${fmtDur(
                w.duration_sec,
              )} elapsed — the head unit auto-paused while stopped.`}
            />`
          : html`<${Metric} k="time" v=${fmtDur(w.duration_sec)} />`}
        <${Metric} k="dist" v=${dist} />
        <${Metric} k="avg hr" v=${round(w.avg_hr)} />
        <${Metric} k="max hr" v=${w.max_hr} />
        ${isSwim
          ? html`<${Metric}
              k="pool"
              v=${w.pool_length_m != null ? `${w.pool_length_m}m` : null}
            />`
          : null}
        ${isSwim ? html`<${Metric} k="strokes" v=${w.total_strokes} />` : null}
        ${isCalisthenics && w.calisthenics
          ? html`<${Metric} k="sets" v=${w.calisthenics.sequence} />`
          : null}
        ${isCalisthenics && w.calisthenics
          ? html`<${EffortMetric} pct=${w.calisthenics.effort_pct} />`
          : null}
        <${Metric} k="kcal" v=${round(w.active_energy)} />
      </div>
      <div class="card__arrow">
        <${I} name="ArrowRight" size=${18} weight="bold" />
      </div>
    </a>
  `;
}

// Sport filter row — "All" plus one pill per sport the athlete actually has
// data for. Counts come from the unfiltered facet tally so a pill's number
// never shifts just because a *different* pill is active.
function SportFilter({ sports, total, active, onSelect }) {
  const items = [
    { sport: null, label: "All", count: total, icon: "SquaresFour" },
    ...sports
      .filter((s) => s.sport)
      .sort((a, b) => b.c - a.c)
      .map((s) => ({ sport: s.sport, label: sportLabel(s.sport), count: s.c, icon: sportIcon(s.sport) })),
  ];
  return html`
    <div class="filterbar" role="tablist" aria-label="Filter by sport">
      ${items.map(
        (it) => html`
          <button
            key=${it.sport ?? "all"}
            type="button"
            role="tab"
            aria-selected=${active === it.sport}
            class=${`filterchip ${active === it.sport ? "is-active" : ""}`}
            onClick=${() => onSelect(it.sport)}
          >
            ${active === it.sport
              ? html`<${HdrGlow} className="chip-hdr" />`
              : null}
            <${I} name=${it.icon} size=${14} weight="bold" />${it.label}
            <span class="filterchip__count">${it.count}</span>
          </button>
        `,
      )}
    </div>
  `;
}

// Pager — a compact "NN–NN / total" readout in the app's tabular-mono voice
// (matches .stat__v elsewhere) flanked by prev/next. Renders nothing once
// everything fits on one page, so it never appears for a light logbook.
function Pager({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  return html`
    <div class="pager">
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        onClick=${() => onPage(page - 1)}
        disabled=${page <= 1}
        aria-label="Previous page"
      >
        <${I} name="CaretLeft" size=${14} weight="bold" />Prev
      </button>
      <span class="pager__info"
        >${start}–${end}<span class="faint"> / ${total}</span></span
      >
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        onClick=${() => onPage(page + 1)}
        disabled=${page >= pages}
        aria-label="Next page"
      >
        Next<${I} name="CaretRight" size=${14} weight="bold" />
      </button>
    </div>
  `;
}

// Floating "+" button — the only way to add a workout manually right now
// (calisthenics: pull-ups/push-ups, self-reported, no device to ingest from).
// Tapping it opens a two-item chooser rather than navigating straight to a
// form, since there are already two trackable movements to pick between.
function AddFab() {
  const [open, setOpen] = useState(false);
  return html`
    ${open ? html`<div class="fab-scrim" onClick=${() => setOpen(false)}></div>` : null}
    ${open
      ? html`<div class="fabmenu">
          <a class="fabmenu__item" href="/calisthenics?m=pullup">
            <${I} name="ArrowLineUp" size=${16} weight="bold" />Pull-ups
          </a>
          <a class="fabmenu__item" href="/calisthenics?m=pushup">
            <${I} name="ArrowLineDown" size=${16} weight="bold" />Push-ups
          </a>
        </div>`
      : null}
    <button
      type="button"
      class="fab ${open ? "is-open" : ""}"
      onClick=${() => setOpen((o) => !o)}
      aria-label=${open ? "Close" : "Add a workout"}
    >
      <${HdrGlow} className="btn-hdr" />
      <${I} name="Plus" size=${24} weight="bold" />
    </button>
  `;
}

// Sport filter + page live in the URL (?sport=&page=) so a reload or a
// shared link lands back on the same slice instead of always "All, page 1".
function readParamsFromUrl() {
  const sp = new URLSearchParams(location.search);
  const sport = sp.get("sport") || null;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  return { sport, page };
}
function writeParamsToUrl(sport, page) {
  const sp = new URLSearchParams();
  if (sport) sp.set("sport", sport);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function App() {
  const initial = readParamsFromUrl();
  const [sport, setSport] = useState(initial.sport);
  const [page, setPage] = useState(initial.page);
  const [state, setState] = useState({ status: "loading", workouts: [], total: 0, sports: [] });

  useEffect(() => {
    let cancelled = false;
    // Keep the current cards on screen (dimmed, see .cards--loading) while a
    // filter/page change is in flight, rather than flashing skeletons again —
    // the first-ever load is the only time there's nothing to hold onto.
    setState((s) => ({ ...s, status: s.status === "loading" ? "loading" : "refreshing" }));
    writeParamsToUrl(sport, page);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (sport) params.set("sport", sport);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String((page - 1) * PAGE_SIZE));
        const res = await fetch(`/api/workouts?${params}`);
        const data = await res.json();
        if (cancelled) return;
        const total = data.total || 0;
        // A stale link (bookmarked past the last page, or workouts since
        // deleted) can point offset past the end — land on the real last
        // page instead of showing a misleading "no sessions" empty state.
        const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setState({
          status: "ok",
          workouts: data.workouts || [],
          total,
          sports: data.sports || [],
        });
      } catch (e) {
        if (!cancelled) setState({ status: "error", error: String(e), workouts: [], total: 0, sports: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sport, page]);

  function selectSport(next) {
    setSport(next);
    setPage(1);
  }
  function goToPage(next) {
    setPage(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const allCount = state.sports.reduce((sum, s) => sum + s.c, 0);

  // HDR wordmark: the "AI" is lit by masking the brand video to a canvas-drawn
  // text shape (see useAiMask). No-op on SDR displays — ui.css gates the layer.
  const nameRef = useRef(null);
  const aiRef = useRef(null);
  const aiLayerRef = useRef(null);
  useAiMask(nameRef, aiRef, aiLayerRef);

  return html`
    <div class="wrap">
      <header class="topbar">
        <div class="brand">
          <div class="brand__mark">
            <${HdrGlow} className="mark-hdr" />
            <${I} name="Waveform" size=${22} weight="bold" />
          </div>
          <div>
            <div class="brand__name" ref=${nameRef}>
              Tr<span class="brand__ai" ref=${aiRef}>AI</span>ner
              <span class="name-hdr" ref=${aiLayerRef}>
                <${HdrGlow} className="" />
              </span>
            </div>
            <div class="brand__sub">Logbook</div>
          </div>
        </div>
        <div class="topbar__right">
          <div class="userchip">
            <${I} name="UserCircle" size=${17} weight="duotone" /><span
              >${BOOT.name}</span
            >
          </div>
          <a class="iconbtn iconbtn--icon" href="/settings" title="Settings" aria-label="Settings">
            <${I} name="GearSix" size=${17} weight="duotone" />
          </a>
        </div>
      </header>

      <div class="section-label">
        Recent sessions
        ${state.status !== "loading"
          ? html`<span class="count">${state.total}</span>`
          : null}
      </div>

      ${state.status !== "loading" && (state.sports.length > 1 || sport)
        ? html`<${SportFilter}
            sports=${state.sports}
            total=${allCount}
            active=${sport}
            onSelect=${selectSport}
          />`
        : null}

      ${renderBody(state, sport)}

      ${state.status !== "loading"
        ? html`<${Pager} page=${page} limit=${PAGE_SIZE} total=${state.total} onPage=${goToPage} />`
        : null}

      <${AddFab} />
    </div>
  `;
}

function renderBody(state, sport) {
  if (state.status === "loading") {
    return html`<div class="cards">
      ${[0, 1, 2].map((i) => html`<div class="skeleton" key=${i} />`)}
    </div>`;
  }
  if (state.status === "error") {
    return html`<div class="empty">
      <${I} name="WarningCircle" size=${30} weight="duotone" />
      <p>
        Failed to load workouts.<br /><span class="faint">${state.error}</span>
      </p>
    </div>`;
  }
  if (!state.workouts.length) {
    return html`<div class="empty">
      <${I} name="Wind" size=${32} weight="duotone" />
      <p>
        ${sport ? `No ${sportLabel(sport).toLowerCase()} sessions yet.` : "No workouts yet."}<br /><span
          class="faint"
          >${sport ? "Try a different filter." : "Send one from Health Auto Export."}</span
        >
      </p>
    </div>`;
  }
  return html`<div class=${`cards ${state.status === "refreshing" ? "cards--loading" : ""}`}>
    ${state.workouts.map(
      (w, i) => html`<${Card} key=${w.source_id} w=${w} index=${i} />`,
    )}
  </div>`;
}

createRoot(document.getElementById("root")).render(html`
  <${Ph.IconContext.Provider} value=${{ weight: "regular" }}><${App} /></${Ph.IconContext.Provider}>
`);
