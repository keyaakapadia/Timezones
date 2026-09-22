/* Overlap — world time planner */
(() => {
  "use strict";

  // ---------- cities (roughly west → east; order breaks ties inside a zone) ----------
  const CITIES = [
    ["Honolulu", "USA", "Pacific/Honolulu", 1], ["Anchorage", "USA", "America/Anchorage"],
    ["Vancouver", "Canada", "America/Vancouver"], ["Seattle", "USA", "America/Los_Angeles"],
    ["San Francisco", "USA", "America/Los_Angeles", 1], ["Los Angeles", "USA", "America/Los_Angeles", 1],
    ["Phoenix", "USA", "America/Phoenix"], ["Denver", "USA", "America/Denver"],
    ["Mexico City", "Mexico", "America/Mexico_City", 1], ["Dallas", "USA", "America/Chicago"],
    ["Houston", "USA", "America/Chicago"], ["Chicago", "USA", "America/Chicago", 1],
    ["Atlanta", "USA", "America/New_York"], ["Miami", "USA", "America/New_York"],
    ["Toronto", "Canada", "America/Toronto", 1], ["DC", "USA", "America/New_York", 1],
    ["New York", "USA", "America/New_York", 1], ["Boston", "USA", "America/New_York", 1],
    ["Bogotá", "Colombia", "America/Bogota"], ["Lima", "Peru", "America/Lima"],
    ["Caracas", "Venezuela", "America/Caracas"], ["Halifax", "Canada", "America/Halifax"],
    ["Santiago", "Chile", "America/Santiago"], ["Buenos Aires", "Argentina", "America/Argentina/Buenos_Aires", 1],
    ["São Paulo", "Brazil", "America/Sao_Paulo", 1], ["Rio de Janeiro", "Brazil", "America/Sao_Paulo"],
    ["Reykjavík", "Iceland", "Atlantic/Reykjavik"], ["Lisbon", "Portugal", "Europe/Lisbon"],
    ["Dublin", "Ireland", "Europe/Dublin"], ["London", "UK", "Europe/London", 1],
    ["Casablanca", "Morocco", "Africa/Casablanca"], ["Lagos", "Nigeria", "Africa/Lagos", 1],
    ["Madrid", "Spain", "Europe/Madrid"], ["Barcelona", "Spain", "Europe/Madrid", 1],
    ["Paris", "France", "Europe/Paris", 1], ["Amsterdam", "Netherlands", "Europe/Amsterdam"],
    ["Zurich", "Switzerland", "Europe/Zurich"], ["Berlin", "Germany", "Europe/Berlin", 1],
    ["Rome", "Italy", "Europe/Rome", 1], ["Stockholm", "Sweden", "Europe/Stockholm"],
    ["Warsaw", "Poland", "Europe/Warsaw"], ["Athens", "Greece", "Europe/Athens"],
    ["Cairo", "Egypt", "Africa/Cairo", 1], ["Johannesburg", "South Africa", "Africa/Johannesburg", 1],
    ["Tel Aviv", "Israel", "Asia/Jerusalem", 1], ["Istanbul", "Türkiye", "Europe/Istanbul", 1],
    ["Nairobi", "Kenya", "Africa/Nairobi"], ["Moscow", "Russia", "Europe/Moscow", 1],
    ["Riyadh", "Saudi Arabia", "Asia/Riyadh"], ["Tehran", "Iran", "Asia/Tehran"],
    ["Dubai", "UAE", "Asia/Dubai", 1], ["Karachi", "Pakistan", "Asia/Karachi"],
    ["Mumbai", "India", "Asia/Kolkata", 1], ["Delhi", "India", "Asia/Kolkata"],
    ["Bengaluru", "India", "Asia/Kolkata"], ["Kathmandu", "Nepal", "Asia/Kathmandu"],
    ["Dhaka", "Bangladesh", "Asia/Dhaka"], ["Bangkok", "Thailand", "Asia/Bangkok", 1],
    ["Ho Chi Minh", "Vietnam", "Asia/Ho_Chi_Minh"], ["Jakarta", "Indonesia", "Asia/Jakarta"],
    ["Kuala Lumpur", "Malaysia", "Asia/Kuala_Lumpur"], ["Singapore", "Singapore", "Asia/Singapore", 1],
    ["Perth", "Australia", "Australia/Perth"], ["Manila", "Philippines", "Asia/Manila"],
    ["Hong Kong", "China", "Asia/Hong_Kong", 1], ["Taipei", "Taiwan", "Asia/Taipei"],
    ["Beijing", "China", "Asia/Shanghai"], ["Shanghai", "China", "Asia/Shanghai", 1],
    ["Seoul", "South Korea", "Asia/Seoul", 1], ["Tokyo", "Japan", "Asia/Tokyo", 1],
    ["Brisbane", "Australia", "Australia/Brisbane"], ["Melbourne", "Australia", "Australia/Melbourne"],
    ["Sydney", "Australia", "Australia/Sydney", 1], ["Auckland", "New Zealand", "Pacific/Auckland", 1],
  ].map(([name, country, tz, major], order) => ({ id: slug(name), name, country, tz, major: !!major, order }));

  function slug(s) { return s.toLowerCase().normalize("NFD").replace(/[^a-z]/g, ""); }

  const PRESETS = [["newyork", "london"], ["sanfrancisco", "london", "bengaluru"], ["newyork", "london", "tokyo"], ["losangeles", "sydney"]];
  const HALF = 30 * 60000;
  const HOUR = 3600000;
  const WORK_START = 9, WORK_END = 17;

  const store = {
    get(k, d) { try { const v = localStorage.getItem("overlap." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("overlap." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // ---------- the user ----------
  const myTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const PREFERRED = { "America/New_York": "newyork", "America/Los_Angeles": "losangeles", "America/Chicago": "chicago",
    "America/Sao_Paulo": "saopaulo", "Asia/Kolkata": "mumbai", "Asia/Shanghai": "shanghai", "Europe/Madrid": "madrid" };
  const ALL_TZ = new Set((Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []).concat(["UTC"]));

  function customCity(tz) {
    const segs = tz.split("/");
    return { id: "tz:" + tz, name: segs[segs.length - 1].replace(/_/g, " "),
      country: segs.length > 1 ? segs[0].replace(/_/g, " ") : "Time zone", tz, major: true, order: 1000, custom: true };
  }

  let me = CITIES.find((c) => c.id === PREFERRED[myTz]) || CITIES.find((c) => c.tz === myTz);
  if (!me) { me = customCity(myTz); CITIES.push(me); }
  me.isMe = true;
  const byId = Object.fromEntries(CITIES.map((c) => [c.id, c]));

  function ensureCity(id) {
    if (byId[id]) return byId[id];
    if (!id.startsWith("tz:") || !ALL_TZ.has(id.slice(3))) return null;
    const c = customCity(id.slice(3));
    CITIES.push(c);
    byId[c.id] = c;
    if (wheelBuilt) buildWheel();
    return c;
  }

  const state = {
    selected: [],
    h12: store.get("h12", true),
    dur: store.get("dur", 60),
    mode: store.get("mode", "business") === "personal" ? "personal" : "business",
    planDate: null,
    pick: null, // chosen start (ms), null → best suggestion
    hoverCity: null,
  };

  // ---------- time helpers ----------
  const fmtCache = new Map();
  function parts(ms, tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      fmtCache.set(tz, f);
    }
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: o.weekday };
  }
  function offsetMin(ms, tz) {
    const p = parts(ms, tz);
    return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
  }
  function zonedToUtc(y, mo, d, h, mi, tz) {
    const base = Date.UTC(y, mo - 1, d, h, mi);
    let g = base;
    for (let i = 0; i < 3; i++) g = base - offsetMin(g, tz) * 60000;
    return g;
  }
  function fmtOffset(min) {
    const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
    return `UTC${min < 0 ? "−" : "+"}${h}${m ? ":" + String(m).padStart(2, "0") : ""}`;
  }
  function tzAbbr(ms, tz) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
    return (p.find((x) => x.type === "timeZoneName") || {}).value || "";
  }
  function hm(h, mi) {
    const mm = String(mi).padStart(2, "0");
    if (!state.h12) return `${String(h).padStart(2, "0")}:${mm}`;
    return `${h % 12 || 12}:${mm} ${h < 12 ? "am" : "pm"}`;
  }
  function range(ms, tz) {
    const a = parts(ms, tz), b = parts(ms + state.dur * 60000, tz);
    if (state.h12 && (a.h < 12) === (b.h < 12) && !(b.h === 0 && b.mi === 0)) {
      return `${a.h % 12 || 12}:${String(a.mi).padStart(2, "0")} – ${hm(b.h, b.mi)}`;
    }
    return `${hm(a.h, a.mi)} – ${hm(b.h, b.mi)}`;
  }
  const hourOf = (ms, tz) => { const p = parts(ms, tz); return p.h + p.mi / 60; };
  const dateStr = (y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  function todayStr() { const p = parts(Date.now(), myTz); return dateStr(p.y, p.mo, p.d); }
  function shiftDate(str, days) {
    const [y, mo, d] = str.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d + days));
    return dateStr(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  function dayStart() {
    const [y, mo, d] = state.planDate.split("-").map(Number);
    return zonedToUtc(y, mo, d, 0, 0, myTz);
  }

  // ---------- day / night colour ----------
  const STOPS = [
    [0, "#3b4068"], [5, "#454a78"], [6, "#9c80b2"], [7, "#f3a48a"], [8.5, "#ffd98a"], [10, "#ffe9ab"],
    [15, "#ffe9ab"], [17, "#ffd98a"], [18.5, "#f3a48a"], [19.5, "#b58ab8"], [20.5, "#5f6192"], [22, "#3b4068"], [24, "#3b4068"],
  ].map(([h, c]) => [h, [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))]);
  function hourRgb(h) {
    h = ((h % 24) + 24) % 24;
    for (let i = 1; i < STOPS.length; i++) {
      if (h <= STOPS[i][0]) {
        const [h0, c0] = STOPS[i - 1], [h1, c1] = STOPS[i];
        const t = (h - h0) / (h1 - h0);
        return c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
      }
    }
    return STOPS[0][1];
  }
  const hourColor = (h) => `rgb(${hourRgb(h).join(",")})`;

  // Page background follows your local sky: a pale wash by day, deep and dark at night.
  const TINT = 0.28;
  const tintOverride = Number.parseFloat(new URLSearchParams(location.search).get("tint"));
  // Dark from dusk (~7:45pm) until dawn (~6:15am). No in-between shades: mid-tones make every text colour hard to read.
  function isNight(h) {
    h = ((h % 24) + 24) % 24;
    return h >= 19.75 || h < 6.25;
  }
  function applyTint() {
    const h = Number.isFinite(tintOverride) ? tintOverride : hourOf(Date.now(), myTz);
    const sky = hourRgb(h);
    const pale = sky.map((v) => 255 + (v - 255) * TINT);
    const deep = sky.map((v) => v * 0.5);
    const rgb = (isNight(h) ? deep : pale).map(Math.round);
    const bg = rgb.join(",");
    const root = document.documentElement;
    root.style.setProperty("--bg", `rgb(${bg})`);
    root.style.setProperty("--bg-rgb", bg);
    root.dataset.theme = isNight(h) ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = `rgb(${bg})`;
  }
  function dayWord(h) {
    h = ((h % 24) + 24) % 24;
    if (h >= 5 && h < 8) return "sunrise";
    if (h >= 8 && h < 17.5) return "daytime";
    if (h >= 17.5 && h < 20) return "sunset";
    return "night";
  }

  // ---------- scoring ----------
  const MODES = {
    business: {
      status: ["Asleep", "Early / late", "Just outside work hours", "Work hours"],
      quality: ["Tough — someone is asleep", "Workable — someone stretches", "Good", "Great — work hours for all"],
      allGood: "Work hours for everyone.",
      rules: "Business: 9am–5pm on weekdays is ideal. An hour either side is fine, a little further is early or late, and anything else counts as asleep. Weekends count as early or late.",
    },
    personal: {
      status: ["Asleep", "Busy or late", "Free-ish", "Free time"],
      quality: ["Tough — someone is asleep", "Workable — someone is busy", "Good", "Great — everyone is free"],
      allGood: "Everyone is free.",
      rules: "Personal: weekday evenings (6–10pm) and weekend days (10am–9pm) are ideal. Mornings, lunch and late evenings are fine, work hours are possible, and anything else counts as asleep.",
    },
  };
  const M = () => MODES[state.mode];
  const QCOLOR = ["var(--sleep)", "var(--stretch)", "var(--flex)", "var(--work)"];
  const inRange = (h, a, b) => h >= a && h < b;

  function hourScore(h, weekend) {
    h = ((h % 24) + 24) % 24;
    if (state.mode === "personal") {
      if (weekend) {
        if (inRange(h, 10, 21)) return 3;
        if (inRange(h, 8, 10) || inRange(h, 21, 23)) return 2;
        if (inRange(h, 7, 8) || inRange(h, 23, 24)) return 1;
        return 0;
      }
      if (inRange(h, 18, 22)) return 3;
      if (inRange(h, 7, 9) || inRange(h, 12, 13) || inRange(h, 17, 18)) return 2;
      if (inRange(h, 9, 17) || inRange(h, 22, 23)) return 1;
      return 0;
    }
    let s = 0;
    if (inRange(h, WORK_START, WORK_END)) s = 3;
    else if (inRange(h, WORK_START - 1, WORK_START) || inRange(h, WORK_END, WORK_END + 2)) s = 2;
    else if (inRange(h, WORK_START - 2, WORK_START - 1) || inRange(h, WORK_END + 2, WORK_END + 5)) s = 1;
    return weekend ? Math.min(s, 1) : s;
  }
  function blockScore(ms, tz) {
    const p = parts(ms, tz);
    const weekend = p.wd === "Sat" || p.wd === "Sun";
    return { score: hourScore(p.h + p.mi / 60, weekend), weekend };
  }
  const selectedCities = () => state.selected.map((id) => byId[id]).filter(Boolean);

  function evalWindow(t, cities) {
    const n = state.dur / 30;
    const per = cities.map((c) => {
      let score = 3, weekend = false;
      for (let j = 0; j < n; j++) {
        const b = blockScore(t + j * HALF, c.tz);
        score = Math.min(score, b.score);
        weekend = weekend || b.weekend;
      }
      return { c, score, weekend };
    });
    return { t, per, min: Math.min(...per.map((x) => x.score)), sum: per.reduce((a, x) => a + x.score, 0) };
  }

  function suggestions() {
    const cities = selectedCities();
    if (cities.length < 2) return [];
    const start = dayStart();
    const n = state.dur / 30;
    const cands = [];
    for (let k = 0; k + n <= 48; k++) cands.push({ k, ...evalWindow(start + k * HALF, cities) });
    cands.sort((a, b) => b.min - a.min || b.sum - a.sum || a.k - b.k);
    const picked = [];
    for (const c of cands) {
      if (picked.every((p) => Math.abs(p.k - c.k) >= n)) picked.push(c);
      if (picked.length === 3) break;
    }
    const floor = Math.max(1, picked[0].min - 1);
    return picked.filter((p, i) => i === 0 || p.min >= floor);
  }

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  // ---------- wheel ----------
  const R_LINE = 244, R_RING_IN = 250, R_RING_OUT = 262, R_TICK_OUT = 274, R_LABEL = 281;
  const svg = $("wheel");
  const W = { angle: {}, segs: {}, labels: {} };
  let wheelBuilt = false;
  const pt = (a, r) => [r * Math.sin(a), -r * Math.cos(a)];

  function curve(a, b) {
    const [x1, y1] = pt(W.angle[a], R_LINE), [x2, y2] = pt(W.angle[b], R_LINE);
    const k = 0.3, f = (v) => v.toFixed(1);
    return `M${f(x1)},${f(y1)}C${f(x1 * k)},${f(y1 * k)} ${f(x2 * k)},${f(y2 * k)} ${f(x2)},${f(y2)}`;
  }
  function arc(a0, a1, r0, r1) {
    const [x0, y0] = pt(a0, r1), [x1, y1] = pt(a1, r1), [x2, y2] = pt(a1, r0), [x3, y3] = pt(a0, r0);
    return `M${x0},${y0}A${r1},${r1} 0 0 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 0 0 ${x3},${y3}Z`;
  }

  function buildWheel() {
    wheelBuilt = true;
    svg.innerHTML = "";
    const t = Date.now();
    const ordered = [...CITIES].sort((a, b) => offsetMin(t, a.tz) - offsetMin(t, b.tz) || a.order - b.order);
    const step = (2 * Math.PI) / ordered.length;
    ordered.forEach((c, i) => { W.angle[c.id] = i * step; });

    const web = el("g", { class: "web" }, svg);
    W.hot = el("g", { class: "hot" }, svg);
    W.links = el("g", { class: "links" }, svg);
    const ring = el("g", { class: "ring" }, svg);
    const labels = el("g", {}, svg);

    let d = "";
    for (let i = 0; i < ordered.length; i++)
      for (let j = i + 1; j < ordered.length; j++) d += curve(ordered[i].id, ordered[j].id);
    el("path", { d }, web);

    for (const c of ordered) {
      const a = W.angle[c.id];
      W.segs[c.id] = el("path", { d: arc(a - step / 2, a + step / 2, R_RING_IN, R_RING_OUT) }, ring);
      const deg = (a * 180) / Math.PI;
      const flip = deg > 180;
      const g = el("g", {
        class: "label" + (c.major ? " major" : "") + (c.isMe ? " me" : ""),
        transform: `rotate(${deg - 90})`, role: "button", tabindex: "0", "aria-label": `Toggle ${c.name}`,
      }, labels);
      el("line", { class: "tick", x1: R_RING_OUT + 3, x2: R_TICK_OUT, y1: 0, y2: 0 }, g);
      const inner = el("g", { transform: `translate(${R_LABEL},0)${flip ? " rotate(180)" : ""}` }, g);
      el("rect", { class: "hit", x: flip ? -170 : -10, y: -11, width: 180, height: 22 }, inner);
      const text = el("text", { dy: "0.35em", "text-anchor": flip ? "end" : "start" }, inner);
      text.textContent = c.name;
      g.addEventListener("click", () => toggle(c.id));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(c.id); } });
      g.addEventListener("mouseenter", () => { state.hoverCity = c.id; renderHot(); showTip(g, c); });
      g.addEventListener("mouseleave", () => { state.hoverCity = null; renderHot(); $("tip").hidden = true; });
      W.labels[c.id] = g;
    }
    updateWheel();
  }

  function updateWheel() {
    const t = Date.now();
    for (const c of CITIES) {
      if (!W.segs[c.id]) continue;
      W.segs[c.id].setAttribute("fill", hourColor(hourOf(t, c.tz)));
      W.labels[c.id].classList.toggle("selected", state.selected.includes(c.id));
    }
    const s = state.selected;
    let d = "";
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) d += curve(s[i], s[j]);
    W.links.innerHTML = "";
    if (d) el("path", { d }, W.links);
  }

  function renderHot() {
    W.hot.innerHTML = "";
    if (!state.hoverCity) return;
    let d = "";
    for (const c of CITIES) if (c.id !== state.hoverCity && W.angle[c.id] != null) d += curve(state.hoverCity, c.id);
    el("path", { d }, W.hot);
  }

  function showTip(g, c) {
    const t = Date.now();
    const p = parts(t, c.tz);
    const box = g.querySelector("text").getBoundingClientRect();
    const wrap = svg.parentElement.getBoundingClientRect();
    const tip = $("tip");
    tip.innerHTML = `<b>${esc(c.name)}</b>${c.isMe ? " · you" : ""} <span class="m">${esc(c.country)}</span>
      <div class="t">${hm(p.h, p.mi)} <span class="m" style="font-size:12px">${p.wd}</span></div>
      <div class="m">${dayWord(p.h + p.mi / 60)} · ${fmtOffset(offsetMin(t, c.tz))}</div>`;
    tip.hidden = false;
    tip.style.left = Math.min(Math.max(box.left + box.width / 2 - wrap.left, 90), wrap.width - 90) + "px";
    tip.style.top = Math.max(box.top - wrap.top, 70) + "px";
  }

  // ---------- header clock ----------
  function updateMe() {
    const t = Date.now();
    const p = parts(t, myTz);
    const mm = String(p.mi).padStart(2, "0"), ss = String(p.s).padStart(2, "0");
    $("meCity").textContent = me.name;
    $("meTime").textContent = state.h12
      ? `${p.h % 12 || 12}:${mm}:${ss} ${p.h < 12 ? "AM" : "PM"}`
      : `${String(p.h).padStart(2, "0")}:${mm}:${ss}`;
    const date = new Intl.DateTimeFormat("en-US", { timeZone: myTz, weekday: "short", month: "short", day: "numeric" }).format(new Date(t));
    $("meMeta").textContent = `${tzAbbr(t, myTz)} · ${fmtOffset(offsetMin(t, myTz))} · ${date}`;
  }

  // ---------- selection & persistence ----------
  function toggle(id) {
    if (!ensureCity(id)) return;
    const i = state.selected.indexOf(id);
    if (i >= 0) state.selected.splice(i, 1); else state.selected.push(id);
    state.pick = null;
    persist();
    render();
  }
  function setCities(ids) {
    ids.forEach(ensureCity);
    state.selected = ids.filter((id) => byId[id]);
    state.pick = null;
    persist();
    render();
  }
  function persist() {
    store.set("selected", state.selected);
    const q = new URLSearchParams();
    if (state.selected.length) q.set("c", state.selected.join(","));
    if (state.planDate !== todayStr()) q.set("d", state.planDate);
    if (state.dur !== 60) q.set("m", state.dur);
    if (state.mode !== "business") q.set("k", state.mode);
    const h = q.toString().replace(/%2C/g, ",").replace(/%3A/g, ":").replace(/%2F/g, "/");
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  // ---------- search ----------
  const search = $("search");
  const results = $("results");
  let items = [];
  let active = 0;

  function runSearch() {
    const q = search.value.trim().toLowerCase();
    if (!q) { closeResults(); return; }
    const t = Date.now();
    const hits = CITIES.filter((c) => c.name.toLowerCase().includes(q) || c.country.toLowerCase().includes(q) || c.tz.toLowerCase().includes(q))
      .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
    const known = new Set(CITIES.map((c) => c.tz));
    const extra = q.length >= 2
      ? [...ALL_TZ].filter((tz) => !known.has(tz) && tz.toLowerCase().replace(/_/g, " ").includes(q)).slice(0, 4).map(customCity)
      : [];
    items = [...hits.slice(0, 7), ...extra];
    active = 0;
    results.innerHTML = items.length ? items.map((c, i) => {
      const p = parts(t, c.tz);
      return `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}">
        <span>${esc(c.name)}${state.selected.includes(c.id) ? '<span class="added">added</span>' : ""}
          <span class="r-sub"> · ${esc(c.country)}</span></span>
        <span class="r-time">${hm(p.h, p.mi)}</span></li>`;
    }).join("") : `<li class="none">No match for “${esc(search.value)}”</li>`;
    results.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }
  function closeResults() { results.hidden = true; search.setAttribute("aria-expanded", "false"); }
  function choose(i) {
    const c = items[i];
    if (!c) return;
    if (c.custom && !byId[c.id]) { CITIES.push(c); byId[c.id] = c; buildWheel(); }
    if (!state.selected.includes(c.id)) toggle(c.id);
    search.value = "";
    closeResults();
  }
  function setActive(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    results.querySelectorAll("li[data-i]").forEach((li) => li.classList.toggle("active", +li.dataset.i === active));
  }
  search.addEventListener("input", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { search.value = ""; closeResults(); search.blur(); }
  });
  results.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); choose(+li.dataset.i); }
  });
  search.addEventListener("blur", () => setTimeout(closeResults, 100));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });

  // ---------- day & length ----------
  function dayText() {
    const today = todayStr();
    const [y, mo, d] = state.planDate.split("-").map(Number);
    const rel = state.planDate === today ? "Today" : state.planDate === shiftDate(today, 1) ? "Tomorrow" : "";
    return rel || new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
      .format(new Date(Date.UTC(y, mo - 1, d)));
  }
  function renderControls() {
    $("dateLabel").textContent = dayText();
    document.querySelectorAll("#lengths button").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.dur));
    document.querySelectorAll("#fmt button").forEach((b) => b.classList.toggle("on", (b.dataset.v === "12") === state.h12));
    document.querySelectorAll("#modeTabs button").forEach((b) => {
      const on = b.dataset.mode === state.mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on);
    });
    $("timesMeta").textContent = `${state.mode === "business" ? "Business" : "Personal"} · ${dayText()} · ${durLabel()}`;
    $("scoringText").textContent = M().rules;
  }
  function setDate(str) { state.planDate = str; state.pick = null; persist(); render(); }
  $("prevDay").addEventListener("click", () => setDate(shiftDate(state.planDate, -1)));
  $("nextDay").addEventListener("click", () => setDate(shiftDate(state.planDate, 1)));
  $("dateLabel").addEventListener("click", () => setDate(todayStr()));
  $("lengths").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.dur = +b.dataset.v;
    store.set("dur", state.dur);
    state.pick = null;
    persist();
    render();
  });
  $("fmt").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.h12 = b.dataset.v === "12";
    store.set("h12", state.h12);
    render();
  });
  $("modeTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.mode === state.mode) return;
    state.mode = b.dataset.mode;
    store.set("mode", state.mode);
    state.pick = null;
    persist();
    render();
  });

  // ---------- result ----------
  const durLabel = () => ({ 30: "30 min", 60: "1 hour", 90: "1.5 hours", 120: "2 hours" })[state.dur];

  function planText(plan) {
    const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: myTz }).format(new Date(plan.t));
    return `Meeting · ${date} · ${durLabel()}\n` +
      plan.per.map((x) => `${x.c.name}: ${range(plan.t, x.c.tz)} (${parts(plan.t, x.c.tz).wd})`).join("\n");
  }

  // Copy times: the picked slot plus its 1–2 runner-up options, each with every city's local time.
  function copyText(plan, others) {
    let text = `Best — ${planText(plan)}`;
    if (others && others.length) {
      text += "\n\n" + others.map((s) => {
        const date = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: myTz }).format(new Date(s.t));
        return `Also works — ${range(s.t, myTz)} · ${date}\n` +
          s.per.map((x) => `${x.c.name}: ${range(s.t, x.c.tz)} (${parts(s.t, x.c.tz).wd})`).join("\n");
      }).join("\n\n");
    }
    return text;
  }
  const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  const listNames = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  // A plain-language reason: who is outside their work day, and how far.
  function reason(plan) {
    const off = plan.per.filter((x) => x.score < 3);
    if (!off.length) return M().allGood;
    const bits = off.map((x) => {
      const h = hourOf(plan.t, x.c.tz);
      const side = h < 12 ? "early" : "late";
      let how;
      if (x.score === 0) how = "the middle of the night";
      else if (state.mode === "personal" && !x.weekend && inRange(h, 12, 13)) how = "lunchtime";
      else if (state.mode === "personal" && !x.weekend && inRange(h, 9, 17)) how = "work hours";
      else if (state.mode === "business" && x.weekend) how = "the weekend";
      else how = x.score === 1 ? side : `a little ${side}`;
      return `${how} in ${x.c.name}`;
    });
    return `It’s ${listNames(bits)}.`;
  }

  function renderResult() {
    const out = $("result");
    const cities = selectedCities();
    if (cities.length < 2) {
      out.innerHTML = `<p class="headline">${cities.length
        ? `${esc(cities[0].name)} is picked. <span class="soft">Add one more city on the circle to find a time.</span>`
        : `Pick two or more cities on the circle. <span class="soft">The best time for everyone to connect shows up here.</span>`}</p>
        <div class="cols">
          <div><p class="eyebrow">Try</p><div class="empty-cities">${PRESETS.map((ids) =>
            `<button data-preset="${ids.join(",")}">${ids.map((id) => esc(byId[id].name)).join(" + ")} →</button>`).join("")}</div></div>
        </div>`;
      return;
    }

    const sugs = suggestions();
    const t = state.pick ?? sugs[0].t;
    const plan = evalWindow(t, cities);
    const myDay = parts(t, myTz);
    const longDate = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: myTz }).format(new Date(t));

    let html = `<p class="headline">${range(t, myTz)} ${t === sugs[0].t ? "works best" : "also works"} for ${esc(listNames(cities.map((c) => c.name)))}.
        <span class="soft">${esc(reason(plan))}</span></p>
      <div class="meta"><span><span class="dot" style="background:${QCOLOR[plan.min]}"></span>${M().quality[plan.min]}</span>
        <span>·</span><span>Your time</span><span>·</span><span>${esc(longDate)}</span><span>·</span><span>${durLabel()}</span></div>
      <div class="cols">
        <div>
          <p class="eyebrow">Everyone’s time</p>
          <ul class="rows">`;
    for (const x of plan.per) {
      const q = parts(t, x.c.tz);
      const shift = Date.UTC(q.y, q.mo - 1, q.d) - Date.UTC(myDay.y, myDay.mo - 1, myDay.d);
      html += `<li>
          <span>${esc(x.c.name)}${x.c.isMe ? '<span class="you">you</span>' : ""}<button class="rm" data-rm="${x.c.id}" aria-label="Remove ${esc(x.c.name)}">Remove</button></span>
          <span class="right">${range(t, x.c.tz)}</span>
          <span class="sub q-${x.score}">${x.weekend && state.mode === "business" ? "Weekend" : M().status[x.score]}</span>
          <span class="sub right">${q.wd}${shift > 0 ? " · next day" : shift < 0 ? " · day before" : ""}</span>
        </li>`;
    }
    html += `</ul></div><div>`;

    const others = sugs.filter((s) => s.t !== t);
    const gcal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("Meeting")}` +
      `&dates=${icsDate(t)}/${icsDate(t + state.dur * 60000)}&details=${encodeURIComponent(planText(plan))}`;
    if (others.length) {
      html += `<p class="eyebrow">Other options</p><ul class="rows">${others.map((s) => {
        const who = s.per.filter((x) => !x.c.isMe).slice(0, 2).map((x) => {
          const p = parts(s.t, x.c.tz);
          return `${esc(x.c.name)} ${hm(p.h, p.mi)}`;
        }).join(" · ");
        return `<li class="pick" data-t="${s.t}" role="button" tabindex="0">
          <span class="t">${range(s.t, myTz)}</span><span class="right sub">${who}</span>
          <span class="sub q-${s.min}">${M().quality[s.min]}</span><span></span>
        </li>`;
      }).join("")}</ul>`;
    } else {
      html += `<p class="eyebrow">Other options</p><p class="dim" style="font-size:16px">This is the only good slot on this day.</p>`;
    }
    html += `<div class="links-row">
        <button id="copyBtn">Copy times</button>
        <a href="${gcal}" target="_blank" rel="noopener">Add to calendar ↗</a>
        <button id="shareBtn">Copy link</button>
      </div></div></div>`;
    out.innerHTML = html;
    out._plan = plan;
    out._others = others;
  }

  $("result").addEventListener("click", async (e) => {
    const t = e.target;
    const preset = t.closest("[data-preset]");
    if (preset) { setCities(preset.dataset.preset.split(",")); return; }
    const rm = t.closest("[data-rm]");
    if (rm) { toggle(rm.dataset.rm); return; }
    const alt = t.closest("[data-t]");
    if (alt) { state.pick = +alt.dataset.t; render(); return; }
    if (t.closest("#copyBtn")) { await copy(copyText($("result")._plan, $("result")._others)); toast("Times copied"); }
    if (t.closest("#shareBtn")) { persist(); await copy(location.href); toast("Link copied"); }
  });
  $("result").addEventListener("keydown", (e) => {
    const alt = e.target.closest("[data-t]");
    if (alt && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); state.pick = +alt.dataset.t; render(); }
  });

  // ---------- render / init ----------
  function render() {
    renderControls();
    updateMe();
    updateWheel();
    renderResult();
  }

  function init() {
    const q = new URLSearchParams(location.hash.slice(1));
    const legacy = !q.has("c") && location.hash.length > 1 && !location.hash.includes("=") ? location.hash.slice(1) : null;
    const fromHash = (q.get("c") || legacy || "").split(",").map(decodeURIComponent).filter(Boolean);
    state.planDate = /^\d{4}-\d{2}-\d{2}$/.test(q.get("d") || "") ? q.get("d") : todayStr();
    if ([30, 60, 90, 120].includes(+q.get("m"))) state.dur = +q.get("m");
    if (q.get("k") === "personal" || q.get("k") === "business") state.mode = q.get("k");

    const saved = fromHash.length ? fromHash : store.get("selected", []);
    saved.forEach(ensureCity);
    state.selected = saved.filter((id) => byId[id]);
    applyTint();
    buildWheel();
    render();

    setInterval(updateMe, 1000);
    let lastMinute = Math.floor(Date.now() / 60000);
    setInterval(() => {
      const m = Math.floor(Date.now() / 60000);
      if (m !== lastMinute) { lastMinute = m; applyTint(); updateWheel(); renderResult(); }
    }, 5000);
  }

  init();
})();
