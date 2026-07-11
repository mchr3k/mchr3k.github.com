/* Floor Plan Designer
 * A dependency-free, local-first tool for sketching room layouts.
 *
 * Units: everything is stored internally in centimetres (cm). Rooms are
 * created from a metres input for convenience, but all edges read/write cm.
 *
 * Rooms and objects are axis-aligned rectangles; rooms may also carry "notches"
 * — rectangular cut-ins (recesses, e.g. chimney breasts) and cut-outs
 * (protrusions, e.g. bay windows) attached to a wall, nestable to any depth.
 * Rendering and edge editing go through a small geometry layer (itemLocalGeometry
 * / walkEdge) that emits a rectilinear polygon whose every edge carries a setter,
 * so all edge lengths stay directly editable in cm.
 */

(() => {
  "use strict";

  const STORAGE_KEY = "floorplan.state.v3";
  const SCHEMA_VERSION = 3;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  /** @typedef {{id:string,name:string,x:number,y:number,w:number,h:number,rot:number,color:string}} FObject */
  /** @typedef {{id:string,name:string,x:number,y:number,w:number,h:number,color:string,objects:FObject[]}} FRoom */
  /** @typedef {{id:string,name:string,rooms:FRoom[]}} FLayout */

  // The document holds many named layouts (full sets of rooms + furniture) so
  // the whole arrangement can be duplicated to explore alternatives. `state`
  // always points at the active layout, so the rest of the code uses
  // `state.rooms` unchanged. Both are assigned in boot() once all the
  // helper declarations below (uid, normalize, …) are initialized.
  let doc;
  let state;
  // View transform: screen_px = world_cm * scale + offset
  let view = { scale: 0.45, ox: 70, oy: 70 };
  let ui = { grid: true, snap: true, roomEdges: true, objEdges: true, objects: true, electrics: true, area: false, gridCm: 10 };
  // The toolbar toggles persist per device. Loaded into `ui` before the first
  // render, then mirrored onto the checkboxes.
  const UI_PREFS_KEY = "floorplan.uiprefs.v1";
  function loadUiPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "null");
      if (p && typeof p === "object") {
        if (typeof p.grid === "boolean") ui.grid = p.grid;
        if (typeof p.snap === "boolean") ui.snap = p.snap;
        // Migrate the old single "edges" pref to the split room/object toggles.
        if (typeof p.edges === "boolean") { ui.roomEdges = p.edges; ui.objEdges = p.edges; }
        if (typeof p.roomEdges === "boolean") ui.roomEdges = p.roomEdges;
        if (typeof p.objEdges === "boolean") ui.objEdges = p.objEdges;
        if (typeof p.objects === "boolean") ui.objects = p.objects;
        if (typeof p.electrics === "boolean") ui.electrics = p.electrics;
        if (typeof p.area === "boolean") ui.area = p.area;
      }
    } catch (_) {}
  }
  function saveUiPrefs() {
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
        grid: ui.grid, snap: ui.snap, roomEdges: ui.roomEdges, objEdges: ui.objEdges,
        objects: ui.objects, electrics: ui.electrics, area: ui.area,
      }));
    } catch (_) {}
  }
  function syncUiControls() {
    el("chk-room-edges").checked = ui.roomEdges;
    el("chk-obj-edges").checked = ui.objEdges;
    el("chk-objects").checked = ui.objects;
    el("chk-electrics").checked = ui.electrics;
    el("chk-grid").checked = ui.grid;
    el("chk-snap").checked = ui.snap;
    el("chk-area").checked = ui.area;
  }
  /** @type {{kind:'room'|'object', roomId:string, objId?:string}|null} */
  let selection = null;
  // Laser-measure tool. When non-null the app is in laser mode: edge labels are
  // hidden and a draggable "laser" casts a horizontal/vertical ray that reads the
  // distance to the room walls (cut-in/out aware) — optionally stopping at
  // objects. { x, y } world cm; target 'walls'|'objects'; axis 'h'|'v';
  // dir 1 (forwards) | -1 (backwards); mode 'span' (side-to-side) | 'tool'.
  let laser = null;
  // When locked, the canvas is view/select-only: dragging pans and edge labels
  // just select, so nothing can be moved or edited by accident. Pan/zoom and the
  // side panel still work. Defaults on per device (set in boot()).
  let locked = false;

  const SVGNS = "http://www.w3.org/2000/svg";
  const PALETTE = ["#c7d2fe", "#bbf7d0", "#fde68a", "#fecaca", "#bae6fd", "#ddd6fe", "#fbcfe8"];

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------
  const svg = document.getElementById("canvas");
  const wrap = document.getElementById("canvas-wrap");
  const panel = document.getElementById("panel");
  const panelEmpty = document.getElementById("panel-empty");
  const panelDetails = document.getElementById("panel-details");

  const el = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const uid = (p) => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v) => Math.round(v);

  function snapVal(v) {
    return ui.snap ? Math.round(v / ui.gridCm) * ui.gridCm : Math.round(v);
  }

  function worldToScreen(x, y) {
    return [x * view.scale + view.ox, y * view.scale + view.oy];
  }
  function screenToWorld(px, py) {
    return [(px - view.ox) / view.scale, (py - view.oy) / view.scale];
  }
  function mousePos(e) {
    const r = svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function rotatePoint(px, py, cx, cy, deg) {
    const a = (deg * Math.PI) / 180;
    const s = Math.sin(a);
    const c = Math.cos(a);
    const dx = px - cx;
    const dy = py - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  }

  // ---------- Geometry layer ----------
  // An item's outline in its own coordinate frame (cm), as a rectilinear
  // polygon. A plain rectangle has no wall features; rooms may carry "notches"
  // — axis-aligned rectangular cut-ins (chimney breasts) and cut-outs (bay
  // windows) attached to a wall. Every generated edge records `ctl`, a setter
  // that maps an edited cm length back to the parameter that drives it, so all
  // edges remain directly editable.
  //
  // A notch = { id, side?, pos, width, depth, children:[] }.
  //   side   = which base wall ('top'|'right'|'bottom'|'left'); top-level only.
  //   pos    = distance (cm) along the parent edge from its start to the notch.
  //   width  = length (cm) of the notch along the parent edge.
  //   depth  = signed cm; > 0 cuts out (protrudes), < 0 cuts in (recesses).
  //   children = notches sitting on this notch's face (nestable to any depth).
  const SIDES = {
    top: { start: (it) => [0, 0], dir: [1, 0], len: (it) => it.w, base: "w" },
    right: { start: (it) => [it.w, 0], dir: [0, 1], len: (it) => it.h, base: "h" },
    bottom: { start: (it) => [it.w, it.h], dir: [-1, 0], len: (it) => it.w, base: "w" },
    left: { start: (it) => [0, it.h], dir: [0, -1], len: (it) => it.h, base: "h" },
  };

  // Apply an edited length to a stored numeric field using the change in length
  // (delta), which works uniformly whether the edge is a whole wall, a wall
  // segment, a notch face, or a notch side.
  const setW = (item) => (newLen, oldLen) => { item.w = Math.max(1, Math.round(item.w + (newLen - oldLen))); };
  const setH = (item) => (newLen, oldLen) => { item.h = Math.max(1, Math.round(item.h + (newLen - oldLen))); };
  const setNotchPos = (n) => (newLen, oldLen) => { n.pos = Math.max(0, Math.round(n.pos + (newLen - oldLen))); };
  const setNotchWidth = (n) => (newLen, oldLen) => { n.width = Math.max(1, Math.round(n.width + (newLen - oldLen))); };
  const setNotchDepth = (n) => (newLen, oldLen) => {
    const mag = Math.max(1, Math.round(Math.abs(n.depth) + (newLen - oldLen)));
    n.depth = (n.depth < 0 ? -1 : 1) * mag;
  };

  // Deep-copy a notch (with fresh ids) for duplication.
  const cloneNotch = (n) => ({
    ...n,
    id: uid("n"),
    children: (n.children || []).map(cloneNotch),
  });

  // Walk one straight edge of length `length` from `start` in unit direction
  // `dir`, inserting `notches` along it and returning the resulting chain of
  // edges. Because the polygon is traced with its interior on the right, the
  // exterior ("outward") is the left perpendicular of travel — and a notch's
  // face is just another edge walked the same way, so nesting is recursive.
  // `baseCtl` edits the leftover (un-notched) portion of this edge.
  function walkEdge(start, dir, length, notches, baseCtl) {
    const out = [dir[1], -dir[0]]; // left perpendicular = outward
    const at = (d) => [start[0] + dir[0] * d, start[1] + dir[1] * d];
    const edges = [];
    let cur = start;
    let along = 0;

    const here = (notches || [])
      .map((n) => {
        const width = Math.min(Math.max(1, n.width), length);
        const pos = Math.min(Math.max(0, n.pos), length - width);
        return { n, pos, width };
      })
      .sort((a, b) => a.pos - b.pos);

    for (const { n, pos, width } of here) {
      if (pos > along + 0.01) {
        const p = at(pos);
        edges.push({ a: cur, b: p, len: pos - along, ctl: setNotchPos(n) });
        cur = p;
        along = pos;
      }
      const pa = [cur[0] + out[0] * n.depth, cur[1] + out[1] * n.depth];
      const faceEnd = at(pos + width);
      const pb = [faceEnd[0] + out[0] * n.depth, faceEnd[1] + out[1] * n.depth];
      edges.push({ a: cur, b: pa, len: Math.abs(n.depth), ctl: setNotchDepth(n) });
      // The face runs pa -> pb in the same direction; recurse for any children.
      if (n.children && n.children.length) {
        edges.push(...walkEdge(pa, dir, width, n.children, setNotchWidth(n)));
      } else {
        edges.push({ a: pa, b: pb, len: width, ctl: setNotchWidth(n) });
      }
      edges.push({ a: pb, b: faceEnd, len: Math.abs(n.depth), ctl: setNotchDepth(n) });
      cur = faceEnd;
      along = pos + width;
    }
    if (along < length - 0.01) {
      edges.push({ a: cur, b: at(length), len: length - along, ctl: baseCtl });
    }
    return edges;
  }

  function itemLocalGeometry(item) {
    const notches = (item.notches || []).filter((n) => SIDES[n.side]);

    if (!notches.length) {
      const c = [[0, 0], [item.w, 0], [item.w, item.h], [0, item.h]];
      return {
        points: c,
        edges: [
          { a: c[0], b: c[1], len: item.w, ctl: setW(item) },
          { a: c[1], b: c[2], len: item.h, ctl: setH(item) },
          { a: c[2], b: c[3], len: item.w, ctl: setW(item) },
          { a: c[3], b: c[0], len: item.h, ctl: setH(item) },
        ],
      };
    }

    let edges = [];
    for (const side of ["top", "right", "bottom", "left"]) {
      const S = SIDES[side];
      const baseCtl = S.base === "w" ? setW(item) : setH(item);
      const onSide = notches.filter((n) => n.side === side);
      edges.push(...walkEdge(S.start(item), S.dir, S.len(item), onSide, baseCtl));
    }
    edges = removeSpikes(edges);
    return { points: edges.map((e) => e.a), edges };
  }

  // A notch flush with a corner makes a wall's depth edge backtrack over the
  // neighbouring wall — a 180° "spike" (e.g. a cut-in 0 cm from the corner draws
  // a zero-width line into the corner). Merge such antiparallel consecutive edge
  // pairs so the room simply narrows there, keeping the longer edge's editable
  // control. Cut-outs at a corner stay collinear (an extension), not a spike.
  function removeSpikes(edges) {
    const dir = (e) => {
      const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], m = Math.hypot(dx, dy) || 1;
      return [dx / m, dy / m];
    };
    let merged = true;
    while (merged && edges.length > 3) {
      merged = false;
      const n = edges.length;
      for (let i = 0; i < n; i++) {
        const a = edges[i], b = edges[(i + 1) % n];
        const da = dir(a), db = dir(b);
        if (da[0] * db[0] + da[1] * db[1] < -0.999) {
          const len = Math.hypot(b.b[0] - a.a[0], b.b[1] - a.a[1]);
          const m = { a: a.a, b: b.b, len, ctl: a.len >= b.len ? a.ctl : b.ctl };
          const next = [];
          for (let k = 0; k < n; k++) {
            if (k === i) next.push(m);
            else if (k === (i + 1) % n) continue;
            else next.push(edges[k]);
          }
          edges = len < 0.01 ? next.filter((e) => e !== m) : next;
          merged = true;
          break;
        }
      }
    }
    return edges;
  }

  // Resolve a selection into the live objects it points at.
  function resolveSel() {
    if (!selection) return null;
    const room = state.rooms.find((r) => r.id === selection.roomId);
    if (!room) return null;
    if (selection.kind === "room") return { kind: "room", room, item: room };
    if (selection.kind === "electric") {
      const elec = (room.electrics || []).find((e) => e.id === selection.elecId);
      if (!elec) return null;
      return { kind: "electric", room, elec, item: elec };
    }
    const obj = room.objects.find((o) => o.id === selection.objId);
    if (!obj) return null;
    return { kind: "object", room, obj, item: obj };
  }

  // World-space geometry for an item, accounting for its room origin & rotation.
  function itemGeometry(room, item, rot) {
    const originX = item === room ? room.x : room.x + item.x;
    const originY = item === room ? room.y : room.y + item.y;
    const cxL = item.w / 2;
    const cyL = item.h / 2;
    const toScreen = (lx, ly) => {
      const [rx, ry] = rot ? rotatePoint(lx, ly, cxL, cyL, rot) : [lx, ly];
      return worldToScreen(originX + rx, originY + ry);
    };
    const local = itemLocalGeometry(item);
    const corners = local.points.map(([lx, ly]) => toScreen(lx, ly));
    const centerW = worldToScreen(originX + cxL, originY + cyL);
    const off = 14 / view.scale; // push label ~14px outside, expressed in cm
    const edges = local.edges.map((e, idx) => {
      const mid = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      const dx = mid[0] - cxL;
      const dy = mid[1] - cyL;
      const ml = Math.hypot(dx, dy) || 1;
      return {
        idx,
        len: e.len,
        ctl: e.ctl,
        labelScreen: toScreen(mid[0] + (dx / ml) * off, mid[1] + (dy / ml) * off),
      };
    });
    return { corners, center: centerW, edges };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVGNS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }

  function render() {
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.replaceChildren();

    if (ui.grid) drawGrid(W, H);

    // Overlay for the dragged item + its temporary labels; appended last below.
    dragLayer = drag ? svgEl("g", { class: "drag-overlay", style: "pointer-events:none" }) : null;

    labelCandidates = [];
    for (const room of state.rooms) {
      drawRoom(room);
      if (ui.objects) for (const obj of room.objects) drawObject(room, obj);
    }
    // Edge labels go in a single top layer so they sit above every shape and
    // their overlaps can be resolved globally.
    if (labelCandidates.length) {
      const layer = svgEl("g", { class: "edge-labels" });
      placeEdgeLabels(layer);
      svg.appendChild(layer);
    }
    // The drag overlay goes above even the edge labels so it's always visible.
    if (dragLayer && dragLayer.childNodes.length) svg.appendChild(dragLayer);
    dragLayer = null;
    if (laser) drawLaser();
    updateZoomSelect();
  }

  function drawGrid(W, H) {
    const g = svgEl("g", {});
    const [w0, h0] = screenToWorld(0, 0);
    const [w1, h1] = screenToWorld(W, H);
    const major = 100; // 1 m
    const minor = 10; // 10 cm
    const minorVisible = minor * view.scale >= 7;
    const step = minorVisible ? minor : major;

    const startX = Math.floor(w0 / step) * step;
    const startY = Math.floor(h0 / step) * step;
    for (let x = startX; x <= w1; x += step) {
      const [sx] = worldToScreen(x, 0);
      const isMajor = Math.round(x) % major === 0;
      g.appendChild(
        svgEl("line", {
          x1: sx, y1: 0, x2: sx, y2: H,
          stroke: isMajor ? "#cfd4da" : "#e3e6ea",
          "stroke-width": 1,
        })
      );
    }
    for (let y = startY; y <= h1; y += step) {
      const [, sy] = worldToScreen(0, y);
      const isMajor = Math.round(y) % major === 0;
      g.appendChild(
        svgEl("line", {
          x1: 0, y1: sy, x2: W, y2: sy,
          stroke: isMajor ? "#cfd4da" : "#e3e6ea",
          "stroke-width": 1,
        })
      );
    }
    svg.appendChild(g);
  }

  function pointsStr(corners) {
    return corners.map((c) => `${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  }

  // Measure text with the same SVG engine that renders it. (A canvas
  // measureText disagrees with SVG text metrics on some platforms — notably
  // iOS — which made labels overflow/misalign.)
  const _measText = document.createElementNS(SVGNS, "text");
  _measText.setAttribute("font-family", "system-ui, sans-serif");
  (function () {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("aria-hidden", "true");
    s.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
    s.appendChild(_measText);
    (document.body || document.documentElement).appendChild(s);
  })();
  function measureText(str, size, weight) {
    _measText.setAttribute("font-size", size);
    _measText.setAttribute("font-weight", weight || 400);
    _measText.textContent = str;
    const w = _measText.getComputedTextLength();
    return w || str.length * size * 0.55; // fallback if metrics unavailable
  }

  // Fit a name into `availPx`: the full name if it measures within, otherwise
  // the longest ellipsised prefix that fits while keeping >= `minChars` real
  // characters, or null when it's too small to show.
  function fitLabel(name, availPx, size, weight, minChars) {
    if (measureText(name, size, weight) <= availPx) return name;
    for (let n = name.length - 1; n >= minChars; n--) {
      const s = name.slice(0, n) + "…";
      if (measureText(s, size, weight) <= availPx) return s;
    }
    return null;
  }

  function ellipsizeTo(word, availPx, size, weight) {
    if (measureText(word, size, weight) <= availPx) return word;
    for (let n = word.length - 1; n >= 1; n--) {
      const s = word.slice(0, n) + "…";
      if (measureText(s, size, weight) <= availPx) return s;
    }
    return "…";
  }

  // Wrap a name at word boundaries to fit availW × availH. A too-long word is
  // ellipsised, and the last line gets an ellipsis if words are left over.
  // Returns an array of lines, or null if nothing fits.
  function wrapLabel(name, availW, availH, size, weight) {
    name = String(name || "").trim();
    if (!name || availW < 10) return null;
    const lineH = size * 1.2;
    const maxLines = Math.max(1, Math.floor(availH / lineH));
    const words = name.split(/\s+/);
    const lines = [];
    let cur = "", wi = 0;
    for (; wi < words.length; wi++) {
      const cand = cur ? cur + " " + words[wi] : words[wi];
      if (measureText(cand, size, weight) <= availW) { cur = cand; continue; }
      if (cur) { lines.push(cur); cur = ""; if (lines.length >= maxLines) break; }
      cur = ellipsizeTo(words[wi], availW, size, weight);
    }
    if (cur && lines.length < maxLines) { lines.push(cur); cur = ""; wi = words.length; }
    if ((wi < words.length || cur) && lines.length) {
      let last = lines[lines.length - 1];
      if (!last.endsWith("…")) {
        // Always end with a real ellipsis to signal dropped words. Trim chars
        // off the line until "trimmed…" fits — never append a sentinel letter.
        let s = last;
        while (s && measureText(s + "…", size, weight) > availW) s = s.slice(0, -1);
        lines[lines.length - 1] = (s || last) + "…";
      }
    }
    return lines.length ? lines : null;
  }

  // Every interior horizontal span [x0,x1] of the outline at screen-y `y`, left
  // to right (a deep cut-in can split a row into more than one interval).
  function interiorSpansAt(corners, y) {
    const xs = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (xs[i + 1] - xs[i] > 1) spans.push([xs[i], xs[i + 1]]);
    }
    return spans;
  }

  // Intersection of two lists of [x0,x1] spans.
  function clipSpans(a, b) {
    const out = [];
    for (const [a0, a1] of a) for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
      if (hi - lo > 1) out.push([lo, hi]);
    }
    return out.sort((p, q) => p[0] - q[0]);
  }

  // Find the best spot for a room label. Searches many vertical bands across the
  // whole room and every interior region at each band (so it works in L-shaped
  // rooms and slots next to objects), preferring — in order — a full single line,
  // then a two-line "name / (area)" wrap, and only truncating as a last resort.
  // Returns { x, y, lines: [...] }, where y is the first line's baseline.
  function roomLabelPlacement(corners, name, objRects, extra) {
    const size = 15, weight = 700, lineH = size * 1.2, pad = 6;
    const ys = corners.map((p) => p[1]);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    if (maxY - minY < 24) return null;

    // Free horizontal slots [x0,x1] whose whole glyph band (sampled across rows)
    // lies inside the outline and clear of objects, for a given baseline.
    const slotsAt = (baseline) => {
      const rows = [baseline - 12, baseline - 7, baseline - 2, baseline + 3];
      let spans = interiorSpansAt(corners, rows[0]);
      for (let i = 1; i < rows.length && spans.length; i++) spans = clipSpans(spans, interiorSpansAt(corners, rows[i]));
      const ty0 = baseline - 13, ty1 = baseline + 4;
      const blocks = (objRects || []).filter((o) => o.y0 < ty1 && o.y1 > ty0).map((o) => [o.x0, o.x1]);
      const free = [];
      for (let [L, R] of spans) {
        L += pad; R -= pad;
        if (R - L < 14) continue;
        const bs = blocks.filter((b) => b[1] > L && b[0] < R)
          .map((b) => [Math.max(L, b[0]), Math.min(R, b[1])]).sort((a, b) => a[0] - b[0]);
        let cur = L;
        for (const [bx0, bx1] of bs) { if (bx0 - pad > cur) free.push([cur, bx0 - pad]); cur = Math.max(cur, bx1 + pad); }
        if (R > cur) free.push([cur, R]);
      }
      return free;
    };

    const bands = [];
    for (let dy = 21; dy <= maxY - minY - 3; dy += 12) bands.push(minY + dy);

    const combined = extra ? `${name} ${extra}` : name;
    const wCombined = measureText(combined, size, weight);
    const wName = measureText(name, size, weight);
    const wExtra = extra ? measureText(extra, size, weight) : 0;
    let fallback = null, twoLine = null;

    for (const baseline of bands) {
      if (baseline > maxY - 3) break;
      for (const [fx0, fx1] of slotsAt(baseline)) {
        const w = fx1 - fx0;
        if (w < 14) continue;
        // 1) Full label on one line, here — best; take the highest such spot.
        if (wCombined <= w) return { x: fx0, y: baseline, lines: [combined] };
        // Last-resort truncated single line (first encountered = highest/leftmost).
        if (!fallback) {
          const t = fitLabel(combined, w, size, weight, 2);
          if (t) fallback = { x: fx0, y: baseline, lines: [t] };
        }
        // 2) Two lines: name here, area on the next band, both untruncated.
        if (!twoLine && extra && wName <= w && wExtra <= w) {
          const b2 = baseline + lineH;
          if (b2 <= maxY - 3 && slotsAt(b2).some(([a, b]) => a <= fx0 + 0.5 && b >= fx0 + wExtra - 0.5)) {
            twoLine = { x: fx0, y: baseline, lines: [name, extra] };
          }
        }
      }
    }
    return twoLine || fallback;
  }

  // Resolve where each opening sits along a wall (cm from the wall's start
  // corner). Each opening starts `gap` cm after the previous feature; if its
  // gap/body would run into a cut-out, it re-anchors so the gap is measured
  // from that cut-out's far edge (the "whichever is closest" rule).
  function layoutWallOpenings(wallLen, cutouts, openings) {
    const cuts = cutouts.slice().sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const out = [];
    for (const op of openings) {
      let start = cursor + op.gap;
      for (let i = 0; i <= cuts.length; i++) {
        const c = cuts.find(([s, e]) => e > cursor + 0.001 && s < start + op.width);
        if (!c) break;
        cursor = c[1];
        start = cursor + op.gap;
      }
      const end = start + op.width;
      out.push({ id: op.id, type: op.type, hinge: op.hinge, swing: op.swing, start, end, fits: end <= wallLen + 0.5 });
      cursor = end;
    }
    return out;
  }

  // The wall segments an opening can sit on: each base wall (with its cut-outs
  // as obstacles), plus the front face of every cut-out/cut-in. Each segment
  // carries its local start point, direction, length, inward normal, and the
  // openings assigned to it.
  function roomSegments(room) {
    const segs = [];
    for (const side of ["top", "right", "bottom", "left"]) {
      const S = SIDES[side];
      const dir = S.dir;
      const [sx, sy] = S.start(room);
      segs.push({
        side, dir, sx, sy, len: S.len(room), inward: [-dir[1], dir[0]],
        cutouts: (room.notches || []).filter((n) => n.side === side).map((n) => [n.pos, n.pos + n.width]),
        ops: (room.openings || []).filter((o) => o.side === side && !o.notch),
      });
    }
    for (const n of room.notches || []) {
      const S = SIDES[n.side];
      const dir = S.dir;
      const out = [dir[1], -dir[0]]; // outward from the base wall
      const [bx, by] = S.start(room);
      const absD = Math.abs(n.depth), sgn = n.depth >= 0 ? 1 : -1;
      const dirSide = [out[0] * sgn, out[1] * sgn]; // along a side, from base wall outwards
      const partOps = (part) => (room.openings || []).filter((o) => o.notch === n.id && (o.notchEdge || "face") === part);
      // Front face: parallel to the wall, offset by the notch depth.
      segs.push({
        notchId: n.id, notchEdge: "face", side: n.side, dir,
        sx: bx + dir[0] * n.pos + out[0] * n.depth, sy: by + dir[1] * n.pos + out[1] * n.depth,
        len: n.width, inward: [-dir[1], dir[0]], cutouts: [], ops: partOps("face"),
      });
      if (absD >= 1) {
        // Two sides, perpendicular to the wall; inward points into the notch.
        segs.push({
          notchId: n.id, notchEdge: "side1", side: n.side, dir: dirSide,
          sx: bx + dir[0] * n.pos, sy: by + dir[1] * n.pos, len: absD, inward: [dir[0], dir[1]], cutouts: [], ops: partOps("side1"),
        });
        segs.push({
          notchId: n.id, notchEdge: "side2", side: n.side, dir: dirSide,
          sx: bx + dir[0] * (n.pos + n.width), sy: by + dir[1] * (n.pos + n.width), len: absD, inward: [-dir[0], -dir[1]], cutouts: [], ops: partOps("side2"),
        });
      }
    }
    return segs;
  }

  function layoutSegment(seg) {
    return layoutWallOpenings(seg.len, seg.cutouts, seg.ops).map((p, i) => ({ ...p, op: seg.ops[i] }));
  }

  function drawOpenings(g, room) {
    if (!(room.openings || []).length) return;
    for (const seg of roomSegments(room)) {
      if (!seg.ops.length) continue;
      const at = (m) => worldToScreen(room.x + seg.sx + seg.dir[0] * m, room.y + seg.sy + seg.dir[1] * m);
      for (const p of layoutSegment(seg)) {
        const a = clamp(p.start, 0, seg.len), b = clamp(p.end, 0, seg.len);
        if (b - a < 0.5) continue;
        const p1 = at(a), p2 = at(b);
        // Draw the opening being dragged (and its gap labels) into the top
        // overlay so it stays above other rooms, objects and edge labels.
        const dragged = drag && drag.type === "opening" && drag.op === p.op && dragLayer;
        const t = dragged ? dragLayer : g;
        if (p.type === "door") drawDoor(t, p1, p2, seg.inward, room.id, p.op.id, p.hinge, p.swing, p.op.frame || 0, (p.op.leaf || "yes") !== "no");
        else drawWindow(t, p1, p2, seg.inward, room.id, p.op.id);
        // While dragging this opening, show the clear gap on each side.
        if (dragged) {
          drawGapLabel(dragLayer, at, seg.inward, drag.prevEnd, p.start);
          drawGapLabel(dragLayer, at, seg.inward, p.end, drag.nextStart);
        }
      }
    }
  }

  function drawGapLabel(g, at, inward, m0, m1) {
    const gap = Math.round(m1 - m0);
    if (gap < 1) return;
    const [mx, my] = at((m0 + m1) / 2);
    const x = mx + inward[0] * 13, y = my + inward[1] * 13;
    const txt = gap + " cm";
    const wpx = measureText(txt, 11) + 10;
    g.appendChild(svgEl("rect", { x: x - wpx / 2, y: y - 9, width: wpx, height: 18, rx: 4, fill: "#fef3c7", "fill-opacity": 0.96, stroke: "#f59e0b", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(svgEl("text", { x, y: y + 4, "font-size": 11, "text-anchor": "middle", fill: "#92400e", "font-family": "system-ui, sans-serif", style: "pointer-events:none" }, txt));
  }

  function maskWall(g, p1, p2) {
    // Open the wall under an opening with a clean white gap.
    g.appendChild(svgEl("line", {
      x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
      stroke: "#ffffff", "stroke-width": 5, "stroke-linecap": "butt", style: "pointer-events:none",
    }));
  }

  // Transparent grab area spanning the opening, so it can be dragged along the wall.
  function openingHit(eg, p1, p2, inward) {
    const o = 9;
    const pts = [
      [p1[0] + inward[0] * o, p1[1] + inward[1] * o], [p2[0] + inward[0] * o, p2[1] + inward[1] * o],
      [p2[0] - inward[0] * o, p2[1] - inward[1] * o], [p1[0] - inward[0] * o, p1[1] - inward[1] * o],
    ];
    eg.appendChild(svgEl("polygon", { points: pts.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" "), fill: "#000", "fill-opacity": 0, style: "pointer-events:all" }));
  }

  // A quarter-circle path centred on (cx,cy), from `fromPt` to `toPt`, sampled so
  // the curve is always the correct convex sweep (SVG arc flags can pick the
  // wrong centre when the radius equals the chord's circumradius).
  function arcPath(cx, cy, r, fromPt, toPt) {
    const a0 = Math.atan2(fromPt[1] - cy, fromPt[0] - cx);
    let d = Math.atan2(toPt[1] - cy, toPt[0] - cx) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    let s = "";
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const a = a0 + (d * i) / n;
      s += (i ? "L" : "M") + (cx + r * Math.cos(a)).toFixed(1) + " " + (cy + r * Math.sin(a)).toFixed(1);
    }
    return s;
  }

  function drawDoor(g, p1, p2, inward, roomId, opId, hinge, swing, frameCm, hasLeaf) {
    const fullPx = dist(p1, p2) || 1;
    // Frame width per side in screen px, capped so a leaf always remains.
    const fpx = Math.min(Math.max(0, (frameCm || 0) * view.scale), fullPx * 0.45);
    const ux = (p2[0] - p1[0]) / fullPx, uy = (p2[1] - p1[1]) / fullPx; // along the wall
    // Clear-opening jambs, inset from each end by the frame.
    const j1 = [p1[0] + ux * fpx, p1[1] + uy * fpx];
    const j2 = [p2[0] - ux * fpx, p2[1] - uy * fpx];
    const r = dist(j1, j2); // the leaf only spans the clear opening
    const dirVec = swing === "in" ? inward : [-inward[0], -inward[1]];
    const hingePt = hinge === "end" ? j2 : j1;
    const farPt = hinge === "end" ? j1 : j2;
    const tip = [hingePt[0] + dirVec[0] * r, hingePt[1] + dirVec[1] * r];
    const eg = svgEl("g", { class: "opening door", "data-kind": "opening", "data-room": roomId, "data-opening": opId, style: "cursor:move" });
    openingHit(eg, p1, p2, inward);
    // Only the clear opening is cut away; the frame bands stay as wall.
    maskWall(eg, j1, j2);
    if (fpx > 0.5) {
      // Mark each frame band on the wall edge as part of the door.
      eg.appendChild(svgEl("line", { x1: p1[0], y1: p1[1], x2: j1[0], y2: j1[1], stroke: "#475569", "stroke-width": 4, "stroke-linecap": "butt", style: "pointer-events:none" }));
      eg.appendChild(svgEl("line", { x1: p2[0], y1: p2[1], x2: j2[0], y2: j2[1], stroke: "#475569", "stroke-width": 4, "stroke-linecap": "butt", style: "pointer-events:none" }));
    }
    // With no leaf it's an open doorway: show the opening (and frame) but no
    // swing arc or door line.
    if (hasLeaf) {
      // Swing arc from the closed (far jamb) to the open (tip) position, centred on the hinge.
      eg.appendChild(svgEl("path", {
        d: arcPath(hingePt[0], hingePt[1], r, farPt, tip),
        fill: "none", stroke: "#64748b", "stroke-width": 1, "stroke-dasharray": "3 3", style: "pointer-events:none",
      }));
      eg.appendChild(svgEl("line", { x1: hingePt[0], y1: hingePt[1], x2: tip[0], y2: tip[1], stroke: "#475569", "stroke-width": 2, style: "pointer-events:none" }));
    }
    g.appendChild(eg);
  }

  function drawWindow(g, p1, p2, inward, roomId, opId) {
    const eg = svgEl("g", { class: "opening window", "data-kind": "opening", "data-room": roomId, "data-opening": opId, style: "cursor:move" });
    openingHit(eg, p1, p2, inward);
    maskWall(eg, p1, p2);
    const o = 2.2; // half the frame thickness in px
    for (const s of [o, -o]) {
      eg.appendChild(svgEl("line", {
        x1: p1[0] + inward[0] * s, y1: p1[1] + inward[1] * s,
        x2: p2[0] + inward[0] * s, y2: p2[1] + inward[1] * s,
        stroke: "#2563eb", "stroke-width": 1.4, style: "pointer-events:none",
      }));
    }
    eg.appendChild(svgEl("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: "#93c5fd", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(eg);
  }

  // Floor area in m² of the room outline (shoelace on the local-cm polygon, so
  // cut-ins reduce it and cut-outs add to it).
  function roomAreaM2(room) {
    const pts = itemLocalGeometry(room).points;
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2 / 10000; // cm² -> m²
  }

  function drawRoom(room) {
    const sel = selection && selection.kind === "room" && selection.roomId === room.id;
    const geo = itemGeometry(room, room, 0);
    const g = svgEl("g", { class: "room", "data-kind": "room", "data-room": room.id });

    g.appendChild(
      svgEl("polygon", {
        points: pointsStr(geo.corners),
        fill: room.color,
        "fill-opacity": 0.35,
        stroke: sel ? "#2563eb" : "#6b7280",
        "stroke-width": sel ? 3 : 2,
        style: "cursor:move",
      })
    );

    // Room name (+ area, optionally wrapped to a second line) — placed in the
    // best truncation-free interior spot, cut-out/zoom/object aware.
    const objRects = ui.objects ? (room.objects || []).map((o) => {
      const c = itemGeometry(room, o, o.rot || 0).corners;
      const xs = c.map((p) => p[0]), oys = c.map((p) => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...oys), y1: Math.max(...oys) };
    }) : [];
    const areaStr = ui.area ? `(${roomAreaM2(room).toFixed(1)} m²)` : null;
    const place = roomLabelPlacement(geo.corners, room.name, objRects, areaStr);
    if (place) {
      const t = svgEl("text", {
        "font-size": 15, "font-weight": 700, fill: "#1f2933",
        "font-family": "system-ui, sans-serif", style: "pointer-events:none; user-select:none",
      });
      place.lines.forEach((ln, i) => t.appendChild(svgEl("tspan", { x: place.x, y: place.y + i * 15 * 1.2 }, ln)));
      g.appendChild(t);
    }

    drawOpenings(g, room);
    if (ui.electrics) drawElectrics(g, room);
    collectEdgeLabels(geo, room.id, null, sel, room.color);
    if (sel) drawHandles(g, geo);
    svg.appendChild(g);
  }

  function drawObject(room, obj) {
    const sel =
      selection &&
      selection.kind === "object" &&
      selection.roomId === room.id &&
      selection.objId === obj.id;
    const geo = itemGeometry(room, obj, obj.rot || 0);
    const g = svgEl("g", {
      class: "object",
      "data-kind": "object",
      "data-room": room.id,
      "data-obj": obj.id,
    });

    g.appendChild(
      svgEl("polygon", {
        points: pointsStr(geo.corners),
        fill: obj.color,
        "fill-opacity": 0.92,
        stroke: sel ? "#2563eb" : "#475569",
        "stroke-width": sel ? 3 : 1.5,
        style: "cursor:move",
      })
    );

    drawObjectName(g, obj, geo.center);

    collectEdgeLabels(geo, room.id, obj.id, sel, room.color);
    if (drag && drag.type === "object" && drag.obj === obj && dragLayer) {
      if (drag.snapGuides) drawSnapGuides(g, room, drag.snapGuides);
      drawObjectClearances(g, room, obj);
      if (sel) drawHandles(g, geo);
      dragLayer.appendChild(g); // dragged object + its clearances/guides on top
      return;
    }
    if (sel) drawHandles(g, geo);
    svg.appendChild(g);
  }

  // ---------------------------------------------------------------------------
  // Electrics (wall-mounted sockets & switches)
  // ---------------------------------------------------------------------------
  // Ordered wall segments of a room outline (local cm), each a unit direction
  // plus inward/outward normals, and the cumulative perimeter start distance.
  function roomWallSegments(room) {
    const edges = itemLocalGeometry(room).edges;
    let total = 0;
    const segs = edges.map((e) => {
      const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1];
      const len = Math.hypot(dx, dy) || 1;
      const dir = [dx / len, dy / len];
      const s = { a: e.a, len, dir, inward: [-dir[1], dir[0]], outward: [dir[1], -dir[0]], start: total };
      total += len;
      return s;
    });
    return { segs, total };
  }

  // Point + normals at perimeter distance d (local cm), wrapping around corners.
  function perimeterPoint(room, d) {
    const { segs, total } = roomWallSegments(room);
    if (!total) return null;
    let dd = ((d % total) + total) % total;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (dd <= s.len || i === segs.length - 1) {
        const t = Math.min(dd, s.len);
        return { lx: s.a[0] + s.dir[0] * t, ly: s.a[1] + s.dir[1] * t, dir: s.dir, inward: s.inward, outward: s.outward };
      }
      dd -= s.len;
    }
    return null;
  }

  // Nearest perimeter distance to a local-cm point (drag an electric along walls).
  function perimeterProject(room, lx, ly) {
    const { segs } = roomWallSegments(room);
    let best = 0, bestDist = Infinity;
    for (const s of segs) {
      const t = clamp((lx - s.a[0]) * s.dir[0] + (ly - s.a[1]) * s.dir[1], 0, s.len);
      const px = s.a[0] + s.dir[0] * t, py = s.a[1] + s.dir[1] * t;
      const dd = Math.hypot(lx - px, ly - py);
      if (dd < bestDist) { bestDist = dd; best = s.start + t; }
    }
    return Math.round(best);
  }

  function drawElectrics(g, room) {
    for (const e of room.electrics || []) {
      const dragged = drag && drag.type === "electric" && drag.elec === e && dragLayer;
      drawElectric(dragged ? dragLayer : g, room, e);
    }
  }

  function drawElectric(g, room, elec) {
    const p = perimeterPoint(room, elec.d);
    if (!p) return;
    const sel = selection && selection.kind === "electric" && selection.roomId === room.id && selection.elecId === elec.id;
    const u = p.dir, n = elec.face === "out" ? p.outward : p.inward;
    const W = elec.size === "double" ? 15 : 9; // faceplate width along the wall (cm)
    const D = 5; // depth into the face (cm)
    const toS = (a, b) => worldToScreen(room.x + p.lx + u[0] * a + n[0] * b, room.y + p.ly + u[1] * a + n[1] * b);
    const eg = svgEl("g", { class: "electric", "data-kind": "electric", "data-room": room.id, "data-elec": elec.id, style: "cursor:move" });
    const plate = [[-W / 2, 0], [W / 2, 0], [W / 2, D], [-W / 2, D]].map(([a, b]) => toS(a, b));
    eg.appendChild(svgEl("polygon", {
      points: plate.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" "),
      fill: "#ede9fe", "fill-opacity": 0.98, stroke: sel ? "#2563eb" : "#6d28d9", "stroke-width": sel ? 2.5 : 1.5,
    }));
    const offs = elec.size === "double" ? [-W / 4, W / 4] : [0];
    const gh = 2.2; // gang glyph half-size / socket radius (cm)
    for (const o of offs) {
      if (elec.kind === "socket") {
        const c = toS(o, D / 2);
        eg.appendChild(svgEl("circle", { cx: c[0], cy: c[1], r: gh * view.scale, fill: "none", stroke: "#6d28d9", "stroke-width": 1.4, style: "pointer-events:none" }));
      } else {
        const sq = [[-gh, -gh], [gh, -gh], [gh, gh], [-gh, gh]].map(([a, b]) => toS(o + a, D / 2 + b));
        eg.appendChild(svgEl("polygon", { points: sq.map((q) => q[0].toFixed(1) + "," + q[1].toFixed(1)).join(" "), fill: "none", stroke: "#6d28d9", "stroke-width": 1.4, style: "pointer-events:none" }));
        const l1 = toS(o - gh * 0.6, D / 2), l2 = toS(o + gh * 0.6, D / 2);
        eg.appendChild(svgEl("line", { x1: l1[0], y1: l1[1], x2: l2[0], y2: l2[1], stroke: "#6d28d9", "stroke-width": 1.4, style: "pointer-events:none" }));
      }
    }
    g.appendChild(eg);
  }

  // X / Y where the room outline crosses a horizontal / vertical line (local cm).
  function polyCrossingsX(poly, y) {
    const xs = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    return xs;
  }
  function polyCrossingsY(poly, x) {
    const ys = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[0] <= x && b[0] > x) || (b[0] <= x && a[0] > x)) ys.push(a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    }
    return ys;
  }

  // ---------------------------------------------------------------------------
  // Laser measure
  // ---------------------------------------------------------------------------
  function toggleLaser() {
    if (laser) {
      laser = null;
    } else {
      selection = null;
      const [cx, cy] = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
      laser = { x: Math.round(cx), y: Math.round(cy), target: "walls", axis: "h", dir: 1, mode: "span" };
    }
    el("btn-laser").classList.toggle("active", !!laser);
    render();
    refreshPanel();
  }

  // Subtract a union of [lo,hi] "holes" from a union of [lo,hi] "base" intervals.
  function subtractIntervals(base, holes) {
    if (!holes.length) return base.slice();
    const hs = holes.slice().sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [lo, hi] of base) {
      let segs = [[lo, hi]];
      for (const [h0, h1] of hs) {
        const next = [];
        for (const [s0, s1] of segs) {
          if (h1 <= s0 || h0 >= s1) { next.push([s0, s1]); continue; }
          if (h0 > s0) next.push([s0, Math.min(h0, s1)]);
          if (h1 < s1) next.push([Math.max(h1, s0), s1]);
        }
        segs = next;
      }
      for (const s of segs) if (s[1] - s[0] > 0.01) out.push(s);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  // Cast the laser ray and return { from, to (world cm), cm, room } or null. The
  // free space along the axis is the room interior minus any counted objects; if
  // the tool sits inside an object (or a wall) it measures from the nearest free
  // edge rather than through the solid interior.
  function measureLaser() {
    if (!laser) return null;
    const room = state.rooms.find((r) => roomContainsPoint(r, laser.x, laser.y));
    if (!room) return null;
    const horiz = laser.axis === "h";
    const lx = laser.x - room.x, ly = laser.y - room.y; // local cm
    const poly = itemLocalGeometry(room).points;
    const perp = horiz ? ly : lx;
    const cross = (horiz ? polyCrossingsX(poly, ly) : polyCrossingsY(poly, lx)).filter(isFinite).sort((a, b) => a - b);
    const roomIntervals = [];
    for (let i = 0; i + 1 < cross.length; i += 2) roomIntervals.push([cross[i], cross[i + 1]]);
    const objIntervals = [];
    if (laser.target === "objects") {
      for (const o of room.objects || []) {
        const a = objAABBAt(o, o.x, o.y);
        if (horiz) { if (a.top < perp && a.bottom > perp) objIntervals.push([a.left, a.right]); }
        else { if (a.left < perp && a.right > perp) objIntervals.push([a.top, a.bottom]); }
      }
    }
    const free = subtractIntervals(roomIntervals, objIntervals);
    if (!free.length) return null;
    const pos = horiz ? lx : ly;
    const inside = free.find(([f0, f1]) => pos > f0 + 0.01 && pos < f1 - 0.01);
    let lo, hi;
    if (inside) {
      if (laser.mode === "tool") {
        if (laser.dir > 0) { lo = pos; hi = inside[1]; }
        else { lo = inside[0]; hi = pos; }
      } else { lo = inside[0]; hi = inside[1]; }
    } else {
      // Tool sits inside an object/wall: measure the nearest free span, in the
      // aimed direction for "from tool", or the closest one for a full span.
      let iv = null;
      if (laser.mode === "tool" && laser.dir > 0) iv = free.filter(([f0]) => f0 >= pos - 0.01).sort((a, b) => a[0] - b[0])[0];
      else if (laser.mode === "tool") iv = free.filter(([, f1]) => f1 <= pos + 0.01).sort((a, b) => b[1] - a[1])[0];
      else { let best = Infinity; for (const f of free) { const d = Math.min(Math.abs(f[0] - pos), Math.abs(f[1] - pos)); if (d < best) { best = d; iv = f; } } }
      if (!iv) return null;
      lo = iv[0]; hi = iv[1];
    }
    if (hi - lo < 0.5) return null;
    const from = horiz ? [room.x + lo, room.y + ly] : [room.x + lx, room.y + lo];
    const to = horiz ? [room.x + hi, room.y + ly] : [room.x + lx, room.y + hi];
    return { from, to, cm: Math.round(hi - lo), room };
  }

  function laserReadout() {
    if (!laser) return "";
    const m = measureLaser();
    if (!m) return laser.mode === "tool"
      ? "No wall ahead — place the tool in a room and aim into it."
      : "Place the tool inside a room.";
    return `${m.cm} cm  ·  ${(m.cm / 100).toFixed(2)} m`;
  }

  function drawLaser() {
    const g = svgEl("g", { class: "laser" });
    const [tsx, tsy] = worldToScreen(laser.x, laser.y);
    const m = measureLaser();
    if (m) {
      const [ax, ay] = worldToScreen(m.from[0], m.from[1]);
      const [bx, by] = worldToScreen(m.to[0], m.to[1]);
      const horiz = laser.axis === "h";
      const tick = (x, y) => g.appendChild(svgEl("line", {
        x1: horiz ? x : x - 6, y1: horiz ? y - 6 : y, x2: horiz ? x : x + 6, y2: horiz ? y + 6 : y,
        stroke: "#dc2626", "stroke-width": 2, style: "pointer-events:none",
      }));
      g.appendChild(svgEl("line", { x1: ax, y1: ay, x2: bx, y2: by, stroke: "#dc2626", "stroke-width": 2, style: "pointer-events:none" }));
      tick(ax, ay); tick(bx, by);
      drawMeasureLabel(g, (ax + bx) / 2, (ay + by) / 2, m.cm, [tsx, tsy], horiz);
    }
    g.appendChild(svgEl("line", { x1: tsx - 11, y1: tsy, x2: tsx + 11, y2: tsy, stroke: "#dc2626", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(svgEl("line", { x1: tsx, y1: tsy - 11, x2: tsx, y2: tsy + 11, stroke: "#dc2626", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(svgEl("circle", { cx: tsx, cy: tsy, r: 8, fill: "#dc2626", "fill-opacity": 0.18, stroke: "#dc2626", "stroke-width": 2, "data-kind": "laser", style: "cursor:move" }));
    svg.appendChild(g);
  }

  function drawMeasureLabel(g, x, y, cm, avoid, horiz) {
    const txt = cm + " cm";
    const wpx = measureText(txt, 12, 600) + 12;
    // Nudge the label off the measurement line if it would cover the crosshair.
    if (avoid && Math.abs(x - avoid[0]) < wpx / 2 + 11 && Math.abs(y - avoid[1]) < 22) {
      if (horiz) y = avoid[1] - 24; else x = avoid[0] + wpx / 2 + 16;
    }
    g.appendChild(svgEl("rect", { x: x - wpx / 2, y: y - 10, width: wpx, height: 20, rx: 5, fill: "#fee2e2", "fill-opacity": 0.97, stroke: "#dc2626", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(svgEl("text", { x, y: y + 4, "font-size": 12, "font-weight": 600, "text-anchor": "middle", fill: "#991b1b", "font-family": "system-ui, sans-serif", style: "pointer-events:none" }, txt));
  }

  // While dragging an object, show the clear distance from each of its sides to
  // the nearest obstacle on that side — whichever comes first within the side's
  // projected band: another object, or the room wall (following the outline, so
  // cut-ins read closer and cut-outs further).
  function drawObjectClearances(g, room, obj) {
    const poly = itemLocalGeometry(room).points;
    const a = objAABBAt(obj, obj.x, obj.y);
    const others = room.objects.filter((o) => o.id !== obj.id).map((o) => objAABBAt(o, o.x, o.y));
    const at = (lx, ly) => worldToScreen(room.x + lx, room.y + ly);
    const cxm = (a.left + a.right) / 2, cym = (a.top + a.bottom) / 2;
    const band = (lo, hi) => [0, 0.25, 0.5, 0.75, 1].map((k) => lo + (hi - lo) * k);
    const overlapY = (o) => o.top < a.bottom - 0.5 && o.bottom > a.top + 0.5;
    const overlapX = (o) => o.left < a.right - 0.5 && o.right > a.left + 0.5;

    // right
    let e = Infinity;
    for (const y of band(a.top, a.bottom)) { const xs = polyCrossingsX(poly, y).filter((x) => x > a.right + 0.01); if (xs.length) e = Math.min(e, ...xs); }
    for (const o of others) if (overlapY(o) && o.left >= a.right - 0.01) e = Math.min(e, o.left);
    if (isFinite(e)) drawClearLabel(g, at((a.right + e) / 2, cym), Math.round(e - a.right));
    // left
    e = -Infinity;
    for (const y of band(a.top, a.bottom)) { const xs = polyCrossingsX(poly, y).filter((x) => x < a.left - 0.01); if (xs.length) e = Math.max(e, ...xs); }
    for (const o of others) if (overlapY(o) && o.right <= a.left + 0.01) e = Math.max(e, o.right);
    if (isFinite(e)) drawClearLabel(g, at((a.left + e) / 2, cym), Math.round(a.left - e));
    // bottom
    e = Infinity;
    for (const x of band(a.left, a.right)) { const ys = polyCrossingsY(poly, x).filter((y) => y > a.bottom + 0.01); if (ys.length) e = Math.min(e, ...ys); }
    for (const o of others) if (overlapX(o) && o.top >= a.bottom - 0.01) e = Math.min(e, o.top);
    if (isFinite(e)) drawClearLabel(g, at(cxm, (a.bottom + e) / 2), Math.round(e - a.bottom));
    // top
    e = -Infinity;
    for (const x of band(a.left, a.right)) { const ys = polyCrossingsY(poly, x).filter((y) => y < a.top - 0.01); if (ys.length) e = Math.max(e, ...ys); }
    for (const o of others) if (overlapX(o) && o.bottom <= a.top + 0.01) e = Math.max(e, o.bottom);
    if (isFinite(e)) drawClearLabel(g, at(cxm, (a.top + e) / 2), Math.round(a.top - e));
  }

  function drawClearLabel(g, pt, cm) {
    if (cm < 0) return;
    const txt = cm + " cm";
    const wpx = measureText(txt, 11) + 10;
    const [x, y] = pt;
    g.appendChild(svgEl("rect", { x: x - wpx / 2, y: y - 9, width: wpx, height: 18, rx: 4, fill: "#e0ecff", "fill-opacity": 0.96, stroke: "#2563eb", "stroke-width": 1, style: "pointer-events:none" }));
    g.appendChild(svgEl("text", { x, y: y + 4, "font-size": 11, "text-anchor": "middle", fill: "#1e3a8a", "font-family": "system-ui, sans-serif", style: "pointer-events:none" }, txt));
  }

  // Axis-aligned bounding box (local cm) of an object at (x,y), honouring rotation.
  function objAABBAt(obj, x, y) {
    const rot = obj.rot || 0;
    const cx = x + obj.w / 2, cy = y + obj.h / 2;
    const base = [[x, y], [x + obj.w, y], [x + obj.w, y + obj.h], [x, y + obj.h]];
    const c = rot ? base.map(([px, py]) => rotatePoint(px, py, cx, cy, rot)) : base;
    return { left: Math.min(...c.map((p) => p[0])), right: Math.max(...c.map((p) => p[0])), top: Math.min(...c.map((p) => p[1])), bottom: Math.max(...c.map((p) => p[1])) };
  }

  // Snap a dragged object so an edge/centre lines up with another object's
  // edge/centre or a room wall, when within threshold. Returns {x,y,guides}.
  function snapObjectEdges(room, obj, nx, ny) {
    const thr = 7 / view.scale;
    const xT = [0, room.w], yT = [0, room.h];
    // Every room-outline coordinate is a snap target, so objects align to walls
    // and cut-in/out edges, not just the base rectangle.
    for (const [px, py] of itemLocalGeometry(room).points) { xT.push(px); yT.push(py); }
    for (const o of room.objects) {
      if (o.id === obj.id) continue;
      const a = objAABBAt(o, o.x, o.y);
      xT.push(a.left, a.right, (a.left + a.right) / 2);
      yT.push(a.top, a.bottom, (a.top + a.bottom) / 2);
    }
    const m = objAABBAt(obj, nx, ny);
    const guides = {};
    let bx = nx, bdx = thr;
    for (const edge of [m.left, m.right, (m.left + m.right) / 2]) {
      for (const t of xT) { const d = Math.abs(edge - t); if (d < bdx) { bdx = d; bx = nx + (t - edge); guides.x = t; } }
    }
    let by = ny, bdy = thr;
    for (const edge of [m.top, m.bottom, (m.top + m.bottom) / 2]) {
      for (const t of yT) { const d = Math.abs(edge - t); if (d < bdy) { bdy = d; by = ny + (t - edge); guides.y = t; } }
    }
    return { x: Math.round(bx), y: Math.round(by), guides };
  }

  function drawSnapGuides(g, room, guides) {
    const at = (lx, ly) => worldToScreen(room.x + lx, room.y + ly);
    const line = (p1, p2) => g.appendChild(svgEl("line", { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: "#db2777", "stroke-width": 1, "stroke-dasharray": "4 3", style: "pointer-events:none" }));
    if (guides.x != null) line(at(guides.x, 0), at(guides.x, room.h));
    if (guides.y != null) line(at(0, guides.y), at(room.w, guides.y));
  }

  // Is a world point inside a room's outline (accounting for cut-ins/outs)?
  function roomContainsPoint(room, wx, wy) {
    const poly = itemLocalGeometry(room).points;
    const x = wx - room.x, y = wy - room.y;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function reparentObject(fromRoom, obj, toRoom) {
    const i = fromRoom.objects.indexOf(obj);
    if (i >= 0) fromRoom.objects.splice(i, 1);
    const wx = fromRoom.x + obj.x, wy = fromRoom.y + obj.y;
    obj.x = Math.round(wx - toRoom.x);
    obj.y = Math.round(wy - toRoom.y);
    toRoom.objects.push(obj);
  }

  // Object name, word-wrapped to fit the box. If it can't fit left-to-right and
  // the box is taller than it is wide, the text is rotated to read bottom-to-top
  // along the long axis (where there's more room).
  function drawObjectName(g, obj, center) {
    const rot0 = obj.rot || 0;
    const wPx = ((rot0 === 90 || rot0 === 270 ? obj.h : obj.w) * view.scale);
    const hPx = ((rot0 === 90 || rot0 === 270 ? obj.w : obj.h) * view.scale);
    const weight = 600;
    // Word-wrap and, if needed, rotate the name to read bottom-to-top. If it
    // still won't fit, step the font down to a readable floor (9px) rather than
    // hide the name — a small full name beats no name. Prefer the largest size
    // that shows the whole name; otherwise the smallest readable size.
    const layoutAt = (size) => {
      const fitsHoriz = measureText(obj.name, size, weight) <= wPx - 8;
      const vertical = !fitsHoriz && hPx > wPx;
      const lines = wrapLabel(obj.name, (vertical ? hPx : wPx) - 8, (vertical ? wPx : hPx) - 4, size, weight);
      if (!lines) return null;
      return { size, vertical, lines, clipped: lines.some((l) => l.includes("…")) };
    };
    let chosen = null, smallest = null;
    for (const s of [13, 12, 11, 10, 9, 8, 7, 6]) {
      const lay = layoutAt(s);
      if (!lay) continue;
      smallest = lay;
      if (!lay.clipped) { chosen = lay; break; }
    }
    const pick = chosen || smallest;
    if (!pick) return;
    const { size, vertical, lines } = pick;
    const lineH = size * 1.2;
    const startY = center[1] - ((lines.length - 1) * lineH) / 2 + size * 0.35;
    const attrs = {
      "text-anchor": "middle", "font-size": size, "font-weight": weight, fill: "#1f2933",
      "font-family": "system-ui, sans-serif", style: "pointer-events:none; user-select:none",
    };
    const t = svgEl("text", attrs);
    lines.forEach((ln, i) => t.appendChild(svgEl("tspan", { x: center[0], y: startY + i * lineH }, ln)));
    if (vertical) {
      // iOS Safari/WebKit ignores a `transform` set directly on <text> (more so
      // when it holds <tspan>s with absolute x/y), so rotate a wrapping <g>
      // instead — that renders consistently across browsers.
      const rg = svgEl("g", { transform: `rotate(-90 ${center[0].toFixed(1)} ${center[1].toFixed(1)})` });
      rg.appendChild(t);
      g.appendChild(rg);
    } else {
      g.appendChild(t);
    }
  }

  function textLabel(x, y, str, opt = {}) {
    return svgEl(
      "text",
      {
        x, y,
        "font-size": opt.size || 12,
        "font-weight": opt.weight || 400,
        fill: opt.fill || "#1f2933",
        "text-anchor": opt.anchor || "start",
        "font-family": "system-ui, sans-serif",
        style: "pointer-events:none; user-select:none",
      },
      str
    );
  }

  // Edge labels are gathered during the item pass, then positioned by
  // placeEdgeLabels() so overlaps are resolved globally rather than by a blunt
  // per-edge length threshold (which hid short cut-in edges far too eagerly).
  let labelCandidates = [];
  // While dragging, the dragged item and its temporary measurement labels are
  // routed into this overlay group, appended last so they sit above every room,
  // object and edge label. Null when no drag is active.
  let dragLayer = null;
  function collectEdgeLabels(geo, roomId, objId, selected, tint) {
    if (laser) return; // laser mode hides all edge distance labels
    if (objId == null ? !ui.roomEdges : !ui.objEdges) return;
    for (const e of geo.edges) {
      const [lx, ly] = e.labelScreen;
      const txt = `${round(e.len)} cm`;
      const wpx = measureText(txt, 11) + 12;
      labelCandidates.push({ lx, ly, wpx, txt, roomId, objId, idx: e.idx, len: e.len, selected: selected ? 1 : 0, tint });
    }
  }

  function placeEdgeLabels(layer) {
    // Priority: the selected item first, then longer edges. Each label is drawn
    // unless it would overlap one already placed — so a short edge's dimension
    // shows as soon as there's room for it, and only real collisions are hidden.
    labelCandidates.sort((a, b) => b.selected - a.selected || b.len - a.len);
    const placed = [];
    const pad = 2;
    for (const c of labelCandidates) {
      const x = c.lx - c.wpx / 2, y = c.ly - 9, w = c.wpx, h = 18;
      let clash = false;
      for (const r of placed) {
        if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) { clash = true; break; }
      }
      if (clash) continue;
      placed.push({ x, y, w, h });
      layer.appendChild(buildEdgeLabel(c, x, y, w));
    }
  }

  function buildEdgeLabel(c, x, y, w) {
    const eg = svgEl("g", {
      class: "edge-label", "data-kind": "edge", "data-room": c.roomId,
      "data-edge": c.idx, style: "cursor:pointer",
    });
    if (c.objId) eg.setAttribute("data-obj", c.objId);
    eg.appendChild(svgEl("rect", {
      x, y, width: w, height: 18, rx: 4,
      // Tinted to the owning room's colour; pastels keep dark text readable.
      fill: c.tint || "#ffffff", "fill-opacity": 0.95,
      stroke: "rgba(15,23,42,0.25)", "stroke-width": 1,
    }));
    eg.appendChild(svgEl("text", {
      x: c.lx, y: c.ly + 4, "font-size": 11, "text-anchor": "middle", fill: "#1f2933",
      "font-family": "system-ui, sans-serif", style: "pointer-events:none",
    }, c.txt));
    return eg;
  }

  function drawHandles(g, geo) {
    for (const [hx, hy] of geo.corners) {
      g.appendChild(
        svgEl("rect", {
          x: hx - 4, y: hy - 4, width: 8, height: 8,
          fill: "#fff", stroke: "#2563eb", "stroke-width": 2,
          style: "pointer-events:none",
        })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Pointer interaction (mouse + touch unified via Pointer Events)
  // ---------------------------------------------------------------------------
  const pointers = new Map(); // pointerId -> {x,y}
  let drag = null; // {type, ...}
  let pinch = null; // {startDist, startScale, cx, cy}
  const TAP_SLOP = 6; // px of finger movement below which a press counts as a tap

  // Do two selections point at the same room/object?
  function sameSel(a, b) {
    return !!a && !!b && a.kind === b.kind && a.roomId === b.roomId &&
      (a.objId || null) === (b.objId || null) && (a.elecId || null) === (b.elecId || null);
  }

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);
  // Desktop: double-click an edge length to edit it inline.
  svg.addEventListener("dblclick", (e) => {
    const t = e.target.closest('[data-kind="edge"]');
    if (t) { e.preventDefault(); openEdgeEditor(t, e); }
  });

  function onPointerDown(e) {
    // iOS Safari can drop a pointerup/pointercancel, leaving a stale pointer in
    // the map; the next touch then looks like a second finger and triggers a
    // false pinch-zoom. A *primary* pointerdown is the first finger of a fresh
    // gesture, so anything left over is stale — start from a clean slate.
    if (e.isPrimary) {
      pointers.clear();
      pinch = null;
      drag = null;
    }
    pointers.set(e.pointerId, mousePos(e));

    // Two fingers -> pinch zoom / pan; cancel any single-item drag.
    if (pointers.size === 2) {
      drag = null;
      const pts = [...pointers.values()];
      pinch = {
        startDist: dist(pts[0], pts[1]),
        startScale: view.scale,
        startOx: view.ox,
        startOy: view.oy,
        cx: (pts[0][0] + pts[1][0]) / 2,
        cy: (pts[0][1] + pts[1][1]) / 2,
      };
      return;
    }

    // Laser mode: grabbing the crosshair drags the laser; dragging elsewhere
    // pans the view, and a tap on empty space drops the laser there. (Two
    // fingers still pinch-zoom, handled above.)
    if (laser) {
      const [mx, my] = mousePos(e);
      const [tsx, tsy] = worldToScreen(laser.x, laser.y);
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      if (Math.hypot(mx - tsx, my - tsy) <= 14) {
        drag = { type: "laser" };
      } else {
        drag = { type: "pan", startOx: view.ox, startOy: view.oy, startMx: mx, startMy: my, placeLaser: true };
      }
      return;
    }

    const target = e.target.closest("[data-kind]");
    const kind = target ? target.getAttribute("data-kind") : null;

    // Editing an edge length: tap on touch, double-click on desktop (handled by
    // the dblclick listener). Handled before capturing the pointer — capturing
    // would suppress the desktop click/dblclick — and works even when locked.
    if (kind === "edge") {
      if (e.pointerType !== "mouse") openEdgeEditor(target, e);
      return;
    }

    try { svg.setPointerCapture(e.pointerId); } catch (_) {}

    if (!target) {
      startPan(e);
      return;
    }
    const roomId = target.getAttribute("data-room");
    const objId = target.getAttribute("data-obj");
    const elecId = target.getAttribute("data-elec");
    const [gmx, gmy] = mousePos(e);

    if (locked) {
      // View/select only: open the item in the side panel for editing, but
      // never move it — a drag pans instead.
      const sel = elecId ? { kind: "electric", roomId, elecId }
        : objId ? { kind: "object", roomId, objId } : { kind: "room", roomId };
      const wasSelected = roomId ? sameSel(selection, sel) : false;
      if (roomId) select(sel);
      drag = { type: "pan", startOx: view.ox, startOy: view.oy, startMx: gmx, startMy: gmy, lockSel: roomId ? sel : null, wasSelected, moved: false };
      return;
    }

    if (kind === "electric") {
      const room = state.rooms.find((r) => r.id === roomId);
      const elec = room && (room.electrics || []).find((x) => x.id === elecId);
      if (elec) {
        const wasSelected = sameSel(selection, { kind: "electric", roomId, elecId });
        select({ kind: "electric", roomId, elecId });
        drag = { type: "electric", room, elec, grabMx: gmx, grabMy: gmy, moved: false, wasSelected };
      }
      return;
    }

    if (kind === "opening") {
      startOpeningDrag(target, gmx, gmy);
      return;
    }

    if (kind === "object") {
      const wasSelected = sameSel(selection, { kind: "object", roomId, objId });
      select({ kind: "object", roomId, objId });
      const room = state.rooms.find((r) => r.id === roomId);
      const obj = room.objects.find((o) => o.id === objId);
      const [wx, wy] = screenToWorld(gmx, gmy);
      drag = { type: "object", room, obj, startX: obj.x, startY: obj.y, grabX: wx, grabY: wy, grabMx: gmx, grabMy: gmy, moved: false, wasSelected };
    } else if (kind === "room") {
      const wasSelected = sameSel(selection, { kind: "room", roomId });
      select({ kind: "room", roomId });
      const room = state.rooms.find((r) => r.id === roomId);
      const [wx, wy] = screenToWorld(gmx, gmy);
      drag = { type: "room", room, startX: room.x, startY: room.y, grabX: wx, grabY: wy, grabMx: gmx, grabMy: gmy, moved: false, wasSelected };
    }
  }

  function startPan(e) {
    if (e.target.closest("[data-kind]")) return;
    select(null);
    drag = { type: "pan", startOx: view.ox, startOy: view.oy, startMx: mousePos(e)[0], startMy: mousePos(e)[1] };
  }

  // Begin dragging an opening along its wall. Captures the free slot between its
  // neighbours (cut-outs / other openings / wall ends) so the drag is clamped and
  // the next opening can be held in place.
  function startOpeningDrag(target, gmx, gmy) {
    const roomId = target.getAttribute("data-room");
    const opId = target.getAttribute("data-opening");
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const op = (room.openings || []).find((o) => o.id === opId);
    if (!op) return;
    const seg = roomSegments(room).find((s) => s.ops.includes(op));
    if (!seg) return;
    const placed = layoutSegment(seg);
    const P = placed.find((p) => p.op === op);
    if (!P) return;
    const feats = seg.cutouts
      .map(([s, e]) => ({ s, e, op: null }))
      .concat(placed.filter((p) => p.op !== op).map((p) => ({ s: p.start, e: p.end, op: p.op })));
    let prevEnd = 0, nextStart = seg.len, nextOp = null;
    for (const f of feats) if (f.e <= P.start + 0.5) prevEnd = Math.max(prevEnd, f.e);
    for (const f of feats) if (f.s >= P.end - 0.5 && f.s < nextStart) { nextStart = f.s; nextOp = f.op; }
    drag = {
      type: "opening", room, op, dir: seg.dir, width: P.end - P.start,
      prevEnd, nextStart, nextOp, grabStart: P.start, startMx: gmx, startMy: gmy, moved: false,
    };
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, mousePos(e));

    if (pinch && pointers.size >= 2) {
      const pts = [...pointers.values()];
      const d = dist(pts[0], pts[1]);
      const factor = d / pinch.startDist;
      const newScale = clamp(pinch.startScale * factor, 0.05, 6);
      // keep the pinch centre stable
      const [wx, wy] = [
        (pinch.cx - pinch.startOx) / pinch.startScale,
        (pinch.cy - pinch.startOy) / pinch.startScale,
      ];
      view.scale = newScale;
      view.ox = pinch.cx - wx * newScale;
      view.oy = pinch.cy - wy * newScale;
      render();
      return;
    }

    if (!drag) return;
    const [mx, my] = mousePos(e);

    if (drag.type === "laser") {
      const [wx, wy] = screenToWorld(mx, my);
      laser.x = Math.round(wx); laser.y = Math.round(wy);
      render();
      el("laser-readout").textContent = laserReadout();
      return;
    }

    if (drag.type === "pan") {
      // Below the tap threshold, keep it a tap (so a locked tap can select/
      // deselect without nudging the view).
      if (!drag.moved && Math.hypot(mx - drag.startMx, my - drag.startMy) < TAP_SLOP) return;
      drag.moved = true;
      view.ox = drag.startOx + (mx - drag.startMx);
      view.oy = drag.startOy + (my - drag.startMy);
      render();
      return;
    }

    if (drag.type === "electric") {
      if (!drag.moved && Math.hypot(mx - drag.grabMx, my - drag.grabMy) < TAP_SLOP) return;
      drag.moved = true;
      const [wx, wy] = screenToWorld(mx, my);
      drag.elec.d = perimeterProject(drag.room, wx - drag.room.x, wy - drag.room.y);
      render();
      return;
    }

    if (drag.type === "opening") {
      const dir = drag.dir; // unit along the wall/face (axis-aligned)
      const along = ((mx - drag.startMx) * dir[0] + (my - drag.startMy) * dir[1]) / view.scale;
      if (!drag.moved && Math.abs(along * view.scale) < TAP_SLOP) return;
      drag.moved = true;
      const ns = clamp(drag.grabStart + along, drag.prevEnd, drag.nextStart - drag.width);
      drag.op.gap = Math.max(0, Math.round(ns - drag.prevEnd));
      if (drag.nextOp) drag.nextOp.gap = Math.max(0, Math.round(drag.nextStart - (ns + drag.width)));
      render();
      return;
    }

    // Ignore tiny finger jitter so a tap stays a tap (and can deselect).
    if (!drag.moved) {
      if (Math.hypot(mx - drag.grabMx, my - drag.grabMy) < TAP_SLOP) return;
      drag.moved = true;
    }

    const [wx, wy] = screenToWorld(mx, my);
    const dx = wx - drag.grabX;
    const dy = wy - drag.grabY;
    if (drag.type === "object") {
      let nx = snapVal(drag.startX + dx), ny = snapVal(drag.startY + dy);
      if (ui.snap) {
        const s = snapObjectEdges(drag.room, drag.obj, nx, ny); // align with other objects / walls
        nx = s.x; ny = s.y; drag.snapGuides = s.guides;
      } else drag.snapGuides = null;
      drag.obj.x = nx;
      drag.obj.y = ny;
    } else if (drag.type === "room") {
      drag.room.x = snapVal(drag.startX + dx);
      drag.room.y = snapVal(drag.startY + dy);
    }
    render();
    syncPanelPosition();
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (svg.hasPointerCapture && svg.hasPointerCapture(e.pointerId)) {
      try { svg.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    if (pointers.size < 2) pinch = null;
    const d = drag;
    drag = null; // cleared first so the final render drops live guides/clearances
    if (d) {
      if (d.type === "pan") {
        // A tap (no pan) in laser mode drops the laser at that point.
        if (d.placeLaser && laser && !d.moved) {
          const [mx, my] = mousePos(e);
          const [wx, wy] = screenToWorld(mx, my);
          laser.x = Math.round(wx); laser.y = Math.round(wy);
          render();
          el("laser-readout").textContent = laserReadout();
        }
        // Panning doesn't mutate content. A locked tap (no pan) on the already-
        // selected item deselects it.
        else if (!d.moved && d.lockSel && d.wasSelected) select(null);
      } else if (d.moved) {
        // Dropping an object inside a different room re-parents it there.
        if (d.type === "object") {
          const cw = d.room.x + d.obj.x + d.obj.w / 2, ch = d.room.y + d.obj.y + d.obj.h / 2;
          const target = state.rooms.find((r) => r !== d.room && roomContainsPoint(r, cw, ch));
          if (target) {
            reparentObject(d.room, d.obj, target);
            if (selection && selection.kind === "object" && selection.objId === d.obj.id) selection.roomId = target.id;
          }
        }
        save();
        render();
        refreshPanel();
      } else if (d.wasSelected) {
        // Tap (no drag) on the already-selected item clears the selection — a
        // reliable way to deselect on touch, where empty canvas is scarce.
        select(null);
      }
    }
  }

  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  function setLocked(v) {
    locked = v;
    const b = el("btn-lock");
    if (b) {
      b.textContent = locked ? "🔒 Locked" : "🔓 Editing";
      b.classList.toggle("locked", locked);
      b.title = locked
        ? "Canvas locked — drag pans, taps select. Tap to enable editing."
        : "Editing enabled — drag moves items. Tap to lock the canvas.";
    }
    svg.classList.toggle("locked", locked);
  }

  // Wheel zoom (desktop)
  wrap.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [mx, my] = mousePos(e);
      const [wx, wy] = screenToWorld(mx, my);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      view.scale = clamp(view.scale * factor, 0.05, 6);
      view.ox = mx - wx * view.scale;
      view.oy = my - wy * view.scale;
      render();
      syncPanelPosition();
    },
    { passive: false }
  );

  // ---------------------------------------------------------------------------
  // Inline edge length editor
  // ---------------------------------------------------------------------------
  let edgeEditor = null;
  function openEdgeEditor(target, e) {
    closeEdgeEditor();
    const roomId = target.getAttribute("data-room");
    const objId = target.getAttribute("data-obj");
    const edgeIdx = parseInt(target.getAttribute("data-edge"), 10);
    const room = state.rooms.find((r) => r.id === roomId);
    if (!room) return;
    const item = objId ? room.objects.find((o) => o.id === objId) : room;
    if (!item) return;

    // Recompute the edge so we have its current length and its setter `ctl`.
    const edge = itemLocalGeometry(item).edges[edgeIdx];
    if (!edge) return;
    const oldLen = round(edge.len);

    const [mx, my] = mousePos(e);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.step = "1";
    input.value = oldLen;
    input.className = "edge-editor";
    input.style.left = mx + "px";
    input.style.top = my + "px";
    wrap.appendChild(input);
    input.focus();
    input.select();

    // `closing` guards against re-entry: committing removes the focused input,
    // which fires `blur` — without the guard that would apply the edit a second
    // time (doubling the delta), and Escape would commit instead of cancel.
    let closing = false;
    const commit = () => {
      if (closing) return;
      closing = true;
      const v = parseFloat(input.value);
      if (!isNaN(v) && v >= 1) {
        edge.ctl(v, oldLen);
        save();
      }
      closeEdgeEditor();
      render();
      refreshPanel();
    };
    const cancel = () => {
      if (closing) return;
      closing = true;
      closeEdgeEditor();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      else if (ev.key === "Escape") cancel();
    });
    // Ignore the blur caused by the opening tap itself (notably on iOS, where it
    // would close the box before you can type); arm real blur-to-commit shortly
    // after it's open.
    let armed = false;
    setTimeout(() => { armed = true; }, 400);
    input.addEventListener("blur", () => { if (armed) commit(); });
    edgeEditor = input;
  }
  function closeEdgeEditor() {
    if (edgeEditor) {
      const node = edgeEditor;
      edgeEditor = null;
      node.remove();
    }
  }

  // ---------------------------------------------------------------------------
  // Selection + property panel
  // ---------------------------------------------------------------------------
  function select(sel) {
    // Selecting a real item leaves laser mode (so the panel shows the item).
    if (laser && sel) { laser = null; el("btn-laser").classList.remove("active"); }
    selection = sel;
    render();
    refreshPanel();
  }

  function refreshPanel() {
    const panelLaser = el("panel-laser");
    if (laser) {
      panelEmpty.hidden = true;
      panelDetails.hidden = true;
      el("panel-electric").hidden = true;
      panelLaser.hidden = false;
      panel.classList.remove("collapsed");
      el("laser-target").value = laser.target;
      el("laser-axis").value = laser.axis;
      el("laser-dir").value = String(laser.dir);
      el("laser-mode").value = laser.mode;
      el("laser-readout").textContent = laserReadout();
      el("btn-rotate").disabled = true;
      el("btn-duplicate").disabled = true;
      el("btn-delete").disabled = true;
      return;
    }
    panelLaser.hidden = true;
    const panelElectric = el("panel-electric");

    const r = resolveSel();
    if (r && r.kind === "electric") {
      panelEmpty.hidden = true;
      panelDetails.hidden = true;
      panelElectric.hidden = false;
      panel.classList.remove("collapsed");
      el("electric-kind").value = r.elec.kind;
      el("electric-size").value = r.elec.size;
      el("electric-face").value = r.elec.face;
      el("btn-rotate").disabled = true;
      el("btn-duplicate").disabled = false;
      el("btn-delete").disabled = false;
      return;
    }
    panelElectric.hidden = true;

    const hasSel = !!r;
    panelEmpty.hidden = hasSel;
    panelDetails.hidden = !hasSel;
    panel.classList.toggle("collapsed", !hasSel);

    el("btn-rotate").disabled = !(r && r.kind === "object");
    el("btn-duplicate").disabled = !hasSel;
    el("btn-delete").disabled = !hasSel;
    if (!hasSel) return;

    const item = r.item;
    el("panel-title").textContent = r.kind === "room" ? "Room" : "Object";
    el("f-name").value = item.name;
    el("f-w").value = round(item.w);
    el("f-h").value = round(item.h);
    el("f-x").value = round(item.x);
    el("f-y").value = round(item.y);
    el("f-color").value = item.color;
    el("f-x-label").textContent = r.kind === "room" ? "X in plan (cm)" : "X in room (cm)";
    el("f-y-label").textContent = r.kind === "room" ? "Y in plan (cm)" : "Y in room (cm)";

    const rotField = el("f-rot-field");
    rotField.hidden = r.kind !== "object";
    if (r.kind === "object") el("f-rot").value = String(item.rot || 0);

    const walls = el("room-walls");
    walls.hidden = r.kind !== "room";
    if (r.kind === "room") renderWalls(r.room);

    const openings = el("room-openings");
    openings.hidden = r.kind !== "room";
    if (r.kind === "room") renderOpenings(r.room);

    const contents = el("room-contents");
    contents.hidden = r.kind !== "room";
    if (r.kind === "room") renderContents(r.room);
  }

  const SIDE_LABELS = { top: "Top wall", right: "Right wall", bottom: "Bottom wall", left: "Left wall" };

  function renderWalls(room) {
    const list = el("walls-list");
    list.replaceChildren();
    const notches = room.notches || [];
    if (!notches.length) {
      const li = document.createElement("li");
      li.style.cssText = "color:var(--muted);font-size:13px;list-style:none";
      li.textContent = "No cut-ins or cut-outs yet.";
      list.appendChild(li);
      return;
    }
    for (const n of notches) list.appendChild(notchItem(room, n, notches, true));
  }

  // Recursively render one notch (and its children) as an editable card.
  // `siblings` is the array the notch lives in, so it can remove itself.
  function notchItem(room, n, siblings, isTop) {
    const li = document.createElement("li");
    li.className = "wall-item";

    const head = document.createElement("div");
    head.className = "wall-item-head";
    const kindEl = document.createElement("span");
    kindEl.className = "kind";
    kindEl.textContent = n.depth < 0 ? "Cut in" : "Cut out";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.addEventListener("click", () => {
      const i = siblings.indexOf(n);
      if (i >= 0) siblings.splice(i, 1);
      save();
      render();
      refreshPanel();
    });
    head.append(kindEl, del);

    const grid = document.createElement("div");
    grid.className = "wall-grid";
    if (isTop) grid.append(notchField(n, "side", "Wall", "select"));
    grid.append(
      notchField(n, "pos", "Position (cm)", "number"),
      notchField(n, "width", "Width (cm)", "number"),
      notchField(n, "depth", "Depth (cm)", "number")
    );

    // Nested cut in / cut out, placed along this notch's face.
    const nest = document.createElement("div");
    nest.className = "wall-buttons nested";
    const bIn = document.createElement("button");
    bIn.type = "button";
    bIn.textContent = "+ Cut in";
    bIn.addEventListener("click", () => addNotch("inset", n));
    const bOut = document.createElement("button");
    bOut.type = "button";
    bOut.textContent = "+ Cut out";
    bOut.addEventListener("click", () => addNotch("outset", n));
    nest.append(bIn, bOut);

    li.append(head, grid, nest);

    if (n.children && n.children.length) {
      const childList = document.createElement("ul");
      childList.className = "walls-list nested";
      for (const c of n.children) childList.appendChild(notchItem(room, c, n.children, false));
      li.appendChild(childList);
    }
    return li;
  }

  // Build one labelled control for a notch property. Depth is shown as a
  // positive magnitude; its cut-in/cut-out direction is preserved on edit.
  function notchField(n, key, label, type) {
    const wrapEl = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = label;
    let input;
    if (type === "select") {
      input = document.createElement("select");
      for (const s of ["top", "right", "bottom", "left"]) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = SIDE_LABELS[s];
        if (n.side === s) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener("change", (e) => { n.side = e.target.value; save(); render(); });
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.min = key === "pos" ? "0" : "1";
      input.step = "1";
      input.value = key === "depth" ? round(Math.abs(n.depth)) : round(n[key]);
      input.addEventListener("input", (e) => {
        let v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        if (key === "depth") {
          v = Math.max(1, v);
          n.depth = (n.depth < 0 ? -1 : 1) * round(v);
        } else {
          v = Math.max(key === "pos" ? 0 : 1, v);
          n[key] = round(v);
        }
        render();
        saveSoon();
      });
    }
    wrapEl.append(span, input);
    return wrapEl;
  }

  // Add a notch. With no `parent`, it goes on the room's top wall; with a
  // parent, it nests on that notch's face (centred, sized to fit).
  function addNotch(kind, parent) {
    const r = resolveSel();
    if (!r || r.kind !== "room") return;
    const host = parent || r.room;
    const span = parent ? parent.width : r.room.w;
    if (!parent && !r.room.notches) r.room.notches = [];
    if (parent && !parent.children) parent.children = [];
    const width = Math.max(10, Math.min(Math.round(span * 0.4), span - 2));
    const notch = {
      id: uid("n"),
      pos: Math.max(0, Math.round(span / 2 - width / 2)),
      width,
      depth: kind === "outset" ? 40 : -40,
      children: [],
    };
    if (!parent) notch.side = "top";
    (parent ? parent.children : r.room.notches).push(notch);
    save();
    render();
    refreshPanel();
  }

  // ---- Doors & windows ----
  function renderOpenings(room) {
    const list = el("openings-list");
    list.replaceChildren();
    const ops = room.openings || [];
    if (!ops.length) {
      const li = document.createElement("li");
      li.style.cssText = "color:var(--muted);font-size:13px;list-style:none";
      li.textContent = "No doors or windows yet.";
      list.appendChild(li);
      return;
    }
    ops.forEach((o, i) => list.appendChild(openingItem(room, o, i)));
  }

  function mkBtn(txt, title, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = txt;
    if (title) b.title = title;
    b.addEventListener("click", fn);
    return b;
  }

  function openingItem(room, o, i) {
    const li = document.createElement("li");
    li.className = "wall-item";
    const head = document.createElement("div");
    head.className = "wall-item-head";
    const kindEl = document.createElement("span");
    kindEl.className = "kind";
    kindEl.textContent = (o.type === "window" ? "Window" : "Door") + ` · ${SIDE_LABELS[o.side]}`;
    const tools = document.createElement("div");
    tools.className = "wall-buttons nested";
    tools.append(
      mkBtn("↑", "Move earlier along the wall", () => moveOpening(room, i, -1)),
      mkBtn("↓", "Move later along the wall", () => moveOpening(room, i, 1)),
      mkBtn("Remove", "", () => { room.openings.splice(i, 1); save(); render(); refreshPanel(); })
    );
    head.append(kindEl, tools);

    const grid = document.createElement("div");
    grid.className = "wall-grid";
    grid.append(
      openingField(o, "type", "Type", "type"),
      openingLocationField(room, o),
      openingField(o, "gap", "Gap (cm)", "number"),
      openingField(o, "width", "Width (cm)", "number")
    );
    if (o.type === "door") {
      grid.append(openingField(o, "leaf", "Leaf", "leaf"));
      if ((o.leaf || "yes") !== "no") {
        grid.append(openingField(o, "hinge", "Hinge", "hinge"), openingField(o, "swing", "Swing", "swing"));
      }
      grid.append(openingField(o, "frame", "Frame each side (cm)", "number"));
    }
    li.append(head, grid);
    return li;
  }

  // Location selector: a base wall, or the face of a cut-out/cut-in.
  function openingLocationField(room, o) {
    const wrapEl = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = "On";
    const sel = document.createElement("select");
    const add = (val, text) => {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = text;
      sel.appendChild(opt);
    };
    for (const s of ["top", "right", "bottom", "left"]) add("wall:" + s, SIDE_LABELS[s]);
    (room.notches || []).forEach((n, idx) => {
      const base = SIDE_LABELS[n.side] + " · " + (n.depth < 0 ? "cut-in" : "cut-out") + " " + (idx + 1);
      add("notch:" + n.id + ":face", base + " face");
      if (Math.abs(n.depth) >= 1) {
        add("notch:" + n.id + ":side1", base + " side A");
        add("notch:" + n.id + ":side2", base + " side B");
      }
    });
    sel.value = o.notch ? "notch:" + o.notch + ":" + (o.notchEdge || "face") : "wall:" + o.side;
    sel.addEventListener("change", (e) => {
      const v = e.target.value;
      if (v.startsWith("notch:")) {
        const [id, part] = v.slice(6).split(":");
        const n = (room.notches || []).find((x) => x.id === id);
        o.notch = id;
        o.notchEdge = part || "face";
        if (n) o.side = n.side;
      } else {
        o.notch = null;
        o.side = v.slice(5);
      }
      save();
      render();
      refreshPanel();
    });
    wrapEl.append(span, sel);
    return wrapEl;
  }

  function moveOpening(room, i, dir) {
    const a = room.openings, j = i + dir;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    save();
    render();
    refreshPanel();
  }

  function openingField(o, key, label, type) {
    const wrapEl = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = label;
    let input;
    if (type === "select" || type === "type" || type === "hinge" || type === "swing" || type === "leaf") {
      input = document.createElement("select");
      const labels = type === "type" ? { door: "Door", window: "Window" }
        : type === "hinge" ? { start: "Wall start", end: "Wall end" }
        : type === "swing" ? { out: "Outward", in: "Inward" }
        : type === "leaf" ? { yes: "Door", no: "Open (no door)" }
        : SIDE_LABELS;
      const opts = type === "type" ? ["door", "window"]
        : type === "hinge" ? ["start", "end"]
        : type === "swing" ? ["out", "in"]
        : type === "leaf" ? ["yes", "no"]
        : ["top", "right", "bottom", "left"];
      for (const s of opts) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = labels[s];
        if (o[key] === s) opt.selected = true;
        input.appendChild(opt);
      }
      input.addEventListener("change", (e) => { o[key] = e.target.value; save(); render(); refreshPanel(); });
    } else {
      input = document.createElement("input");
      input.type = "number";
      const allowZero = key === "gap" || key === "frame";
      input.min = allowZero ? "0" : "1";
      input.step = "1";
      input.value = round(o[key] || 0);
      input.addEventListener("input", (e) => {
        const v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        let nv = Math.max(allowZero ? 0 : 1, round(v));
        // Keep at least a 2 cm leaf: frame on each side can't eat the whole door.
        if (key === "frame") nv = Math.min(nv, Math.max(0, Math.floor((o.width - 2) / 2)));
        o[key] = nv;
        render();
        saveSoon();
      });
    }
    wrapEl.append(span, input);
    return wrapEl;
  }

  function addOpening(type) {
    const r = resolveSel();
    if (!r || r.kind !== "room") return;
    const room = r.room;
    if (!room.openings) room.openings = [];
    const lastSide = room.openings.length ? room.openings[room.openings.length - 1].side : "top";
    room.openings.push({ id: uid("op"), type, side: lastSide, notch: null, hinge: "start", swing: "out", leaf: "yes", gap: 50, width: type === "door" ? 80 : 120, frame: 0 });
    save();
    render();
    refreshPanel();
  }

  function renderContents(room) {
    const list = el("contents-list");
    list.replaceChildren();
    if (!room.objects.length) {
      const li = document.createElement("li");
      li.textContent = "No objects yet — use + Object.";
      li.style.cursor = "default";
      list.appendChild(li);
      return;
    }
    for (const obj of room.objects) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = obj.name;
      const dims = document.createElement("span");
      dims.textContent = `${round(obj.w)}×${round(obj.h)}`;
      dims.style.color = "var(--muted)";
      li.append(span, dims);
      li.addEventListener("click", () => select({ kind: "object", roomId: room.id, objId: obj.id }));
      list.appendChild(li);
    }
  }

  // Live-edit handlers from the panel
  function bindPanel() {
    el("f-name").addEventListener("input", (e) => {
      const r = resolveSel();
      if (r) { r.item.name = e.target.value; render(); saveSoon(); }
    });
    const numField = (id, key, min) =>
      el(id).addEventListener("input", (e) => {
        const r = resolveSel();
        if (!r) return;
        let v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        if (min != null) v = Math.max(min, v);
        r.item[key] = round(v);
        render();
        saveSoon();
      });
    numField("f-w", "w", 1);
    numField("f-h", "h", 1);
    numField("f-x", "x", null);
    numField("f-y", "y", null);
    el("f-rot").addEventListener("change", (e) => {
      const r = resolveSel();
      if (r && r.kind === "object") { r.item.rot = parseInt(e.target.value, 10) || 0; render(); save(); }
    });
    el("f-color").addEventListener("input", (e) => {
      const r = resolveSel();
      if (r) { r.item.color = e.target.value; render(); saveSoon(); }
    });
  }

  // The panel position never moves, but inputs may need refreshing after a drag.
  function syncPanelPosition() {
    const r = resolveSel();
    if (!r) return;
    if (document.activeElement && document.activeElement.closest("#panel-details")) return;
    el("f-x").value = round(r.item.x);
    el("f-y").value = round(r.item.y);
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  function addRoom() {
    const input = prompt("New room size as  width x height  in metres\n(e.g. 4.2 x 3.5)", "4 x 3");
    if (input == null) return;
    const m = input.replace(/,/g, ".").match(/([\d.]+)\s*[x×*by\s]+\s*([\d.]+)/i);
    let wM = 4, hM = 3;
    if (m) { wM = parseFloat(m[1]); hM = parseFloat(m[2]); }
    if (!(wM > 0) || !(hM > 0)) { alert("Please enter two positive numbers, e.g. 4 x 3"); return; }

    // place new room near the current view centre, snapped
    const [cx, cy] = screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
    const room = {
      id: uid("r"),
      name: "Room " + (state.rooms.length + 1),
      x: snapVal(cx - (wM * 100) / 2),
      y: snapVal(cy - (hM * 100) / 2),
      w: round(wM * 100),
      h: round(hM * 100),
      color: PALETTE[state.rooms.length % PALETTE.length],
      objects: [],
    };
    state.rooms.push(room);
    save();
    select({ kind: "room", roomId: room.id });
  }

  function addObject() {
    let room = null;
    const r = resolveSel();
    if (r) room = r.room;
    else if (state.rooms.length === 1) room = state.rooms[0];
    if (!room) {
      alert("Select the room you want to add the object to first.");
      return;
    }
    const obj = {
      id: uid("o"),
      name: "Object",
      x: snapVal(room.w / 2 - 40),
      y: snapVal(room.h / 2 - 40),
      w: 80,
      h: 80,
      rot: 0,
      color: "#94a3b8",
    };
    room.objects.push(obj);
    save();
    select({ kind: "object", roomId: room.id, objId: obj.id });
  }

  function addElectric() {
    let room = null;
    const r = resolveSel();
    if (r) room = r.room;
    else if (state.rooms.length === 1) room = state.rooms[0];
    if (!room) {
      alert("Select the room you want to add the electric to first.");
      return;
    }
    if (!room.electrics) room.electrics = [];
    // Start it midway along the first (top) wall, a socket facing into the room.
    const segs = roomWallSegments(room).segs;
    const elec = { id: uid("e"), kind: "socket", size: "single", d: segs.length ? Math.round(segs[0].len / 2) : 0, face: "in" };
    room.electrics.push(elec);
    save();
    select({ kind: "electric", roomId: room.id, elecId: elec.id });
  }

  function rotateSel() {
    const r = resolveSel();
    if (!r || r.kind !== "object") return;
    r.item.rot = ((r.item.rot || 0) + 90) % 360;
    save();
    render();
    refreshPanel();
  }

  // Copy/paste duplicates via an in-app clipboard (not the OS clipboard), so
  // Ctrl/Cmd+C then Ctrl/Cmd+V drops a copy — paste repeatedly for more.
  let clipboard = null;

  function copySel() {
    const r = resolveSel();
    if (!r) return;
    clipboard = r.kind === "object"
      ? { kind: "object", data: JSON.parse(JSON.stringify(r.obj)), roomId: r.room.id }
      : { kind: "room", data: JSON.parse(JSON.stringify(r.room)) };
  }

  function pasteClipboard() {
    if (!clipboard) return;
    if (clipboard.kind === "object") {
      const r = resolveSel();
      const room = (r && r.room) || state.rooms.find((rm) => rm.id === clipboard.roomId) || state.rooms[0];
      if (!room) return;
      const clone = { ...clipboard.data, id: uid("o"), x: (clipboard.data.x || 0) + 20, y: (clipboard.data.y || 0) + 20 };
      room.objects.push(clone);
      save();
      select({ kind: "object", roomId: room.id, objId: clone.id });
    } else {
      const src = clipboard.data;
      const clone = {
        ...src, id: uid("r"), name: src.name + " copy",
        x: (src.x || 0) + 30, y: (src.y || 0) + 30,
        notches: (src.notches || []).map(cloneNotch),
        openings: (src.openings || []).map((o) => ({ ...o, id: uid("op") })),
        objects: (src.objects || []).map((o) => ({ ...o, id: uid("o") })),
      };
      state.rooms.push(clone);
      save();
      select({ kind: "room", roomId: clone.id });
    }
  }

  function duplicateSel() {
    const r = resolveSel();
    if (!r) return;
    if (r.kind === "object") {
      const clone = { ...r.obj, id: uid("o"), name: r.obj.name, x: r.obj.x + 20, y: r.obj.y + 20 };
      r.room.objects.push(clone);
      save();
      select({ kind: "object", roomId: r.room.id, objId: clone.id });
    } else if (r.kind === "electric") {
      const clone = { ...r.elec, id: uid("e"), d: r.elec.d + 12 };
      r.room.electrics.push(clone);
      save();
      select({ kind: "electric", roomId: r.room.id, elecId: clone.id });
    } else {
      const clone = {
        ...r.room,
        id: uid("r"),
        name: r.room.name + " copy",
        x: r.room.x + 30,
        y: r.room.y + 30,
        notches: (r.room.notches || []).map(cloneNotch),
        openings: (r.room.openings || []).map((o) => ({ ...o, id: uid("op") })),
        objects: r.room.objects.map((o) => ({ ...o, id: uid("o") })),
      };
      state.rooms.push(clone);
      save();
      select({ kind: "room", roomId: clone.id });
    }
  }

  function deleteSel() {
    const r = resolveSel();
    if (!r) return;
    if (r.kind === "object") {
      r.room.objects = r.room.objects.filter((o) => o.id !== r.obj.id);
    } else if (r.kind === "electric") {
      r.room.electrics = (r.room.electrics || []).filter((e) => e.id !== r.elec.id);
    } else {
      if (r.room.objects.length && !confirm(`Delete "${r.room.name}" and its ${r.room.objects.length} object(s)?`))
        return;
      state.rooms = state.rooms.filter((rm) => rm.id !== r.room.id);
    }
    save();
    select(null);
  }

  // ---------- Layout management (duplicate the whole arrangement) ----------
  function renderLayoutBar() {
    const sel = el("layout-select");
    sel.replaceChildren();
    for (const l of doc.layouts) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.name;
      if (l.id === doc.activeId) opt.selected = true;
      sel.appendChild(opt);
    }
    el("btn-layout-delete").disabled = doc.layouts.length <= 1;
  }

  function setActiveLayout(id) {
    if (!doc.layouts.some((l) => l.id === id)) return;
    doc.activeId = id;
    state = activeLayout();
    selection = null;
    save();
    renderLayoutBar();
    refreshPanel();
    render();
  }

  function cloneLayout(layout, name) {
    return {
      id: uid("l"),
      name,
      rooms: layout.rooms.map((r) => ({
        ...r,
        id: uid("r"),
        notches: (r.notches || []).map(cloneNotch),
        openings: (r.openings || []).map((o) => ({ ...o, id: uid("op") })),
        objects: r.objects.map((o) => ({ ...o, id: uid("o") })),
      })),
    };
  }

  function duplicateLayout() {
    const copy = cloneLayout(activeLayout(), nextCopyName(activeLayout().name));
    doc.layouts.push(copy);
    setActiveLayout(copy.id);
  }

  function newLayout() {
    const layout = { id: uid("l"), name: "Layout " + (doc.layouts.length + 1), rooms: [] };
    doc.layouts.push(layout);
    setActiveLayout(layout.id);
  }

  function renameLayout() {
    const l = activeLayout();
    const name = prompt("Rename layout", l.name);
    if (name == null) return;
    l.name = name.trim() || l.name;
    save();
    renderLayoutBar();
  }

  function deleteLayout() {
    if (doc.layouts.length <= 1) return;
    const l = activeLayout();
    if (!confirm(`Delete layout "${l.name}"? This cannot be undone.`)) return;
    doc.layouts = doc.layouts.filter((x) => x.id !== l.id);
    setActiveLayout(doc.layouts[0].id);
  }

  // "Layout 1" -> "Layout 1 copy" -> "Layout 1 copy 2" ...
  function nextCopyName(base) {
    const root = base.replace(/ copy( \d+)?$/, "");
    let candidate = root + " copy";
    let n = 2;
    const names = new Set(doc.layouts.map((l) => l.name));
    while (names.has(candidate)) candidate = root + " copy " + n++;
    return candidate;
  }

  function fitView() {
    if (!state.rooms.length) {
      view = { scale: 0.45, ox: 70, oy: 70 };
      render();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const room of state.rooms) {
      minX = Math.min(minX, room.x);
      minY = Math.min(minY, room.y);
      maxX = Math.max(maxX, room.x + room.w);
      maxY = Math.max(maxY, room.y + room.h);
    }
    const pad = 60;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const sx = (W - pad * 2) / Math.max(1, maxX - minX);
    const sy = (H - pad * 2) / Math.max(1, maxY - minY);
    view.scale = clamp(Math.min(sx, sy), 0.05, 6);
    view.ox = pad - minX * view.scale + (W - pad * 2 - (maxX - minX) * view.scale) / 2;
    view.oy = pad - minY * view.scale + (H - pad * 2 - (maxY - minY) * view.scale) / 2;
    render();
  }

  function zoomBy(factor) {
    zoomTo(view.scale * factor);
  }
  // Set an absolute zoom (px per cm), keeping the canvas centre stable.
  function zoomTo(scale) {
    const [mx, my] = [wrap.clientWidth / 2, wrap.clientHeight / 2];
    const [wx, wy] = screenToWorld(mx, my);
    view.scale = clamp(scale, 0.05, 6);
    view.ox = mx - wx * view.scale;
    view.oy = my - wy * view.scale;
    render();
  }

  const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200, 400];
  // Reflect the current zoom in the toolbar dropdown (a live "73%" option when
  // it's not on a preset).
  function updateZoomSelect() {
    const sel = el("zoom-select");
    if (!sel) return;
    const pct = Math.round(view.scale * 100);
    const cur = sel.querySelector('option[value="__current"]');
    if (cur) cur.textContent = pct + "%";
    const preset = ZOOM_PRESETS.find((p) => Math.abs(p - pct) < 0.5);
    sel.value = preset != null ? String(preset) : "__current";
  }

  // ---------------------------------------------------------------------------
  // Import / export / persistence
  // ---------------------------------------------------------------------------
  function serialize() {
    return JSON.stringify(
      {
        version: SCHEMA_VERSION,
        rev: doc.rev || 0,
        updatedAt: doc.updatedAt || 0,
        activeId: doc.activeId,
        view,
        layouts: doc.layouts,
        // Per-client last-write log so every device can show who last wrote.
        writers: doc.writers && typeof doc.writers === "object" ? doc.writers : {},
      },
      null,
      2
    );
  }

  function exportPlan() {
    const blob = new Blob([serialize()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "floorplan-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importPlan(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || (!Array.isArray(data.rooms) && !Array.isArray(data.layouts)))
          throw new Error("not a floor plan file");
        doc = normalize(data);
        state = activeLayout();
        if (data.view && typeof data.view.scale === "number") view = data.view;
        selection = null;
        save();
        renderLayoutBar();
        render();
        refreshPanel();
        fitView();
      } catch (err) {
        alert("Could not import that file: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  // Normalise a notch (recursively, including nested children). Only top-level
  // notches carry a `side`; nested ones sit on their parent's face.
  function normalizeNotch(n, isTop) {
    const out = {
      id: n.id || uid("n"),
      pos: Math.max(0, +n.pos || 0),
      width: Math.max(1, +n.width || 50),
      depth: +n.depth || -40,
      children: (n.children || []).map((c) => normalizeNotch(c, false)),
    };
    if (isTop) out.side = ["top", "right", "bottom", "left"].includes(n.side) ? n.side : "top";
    return out;
  }

  function normalizeRoom(r) {
    return {
      id: r.id || uid("r"),
      name: r.name || "Room",
      x: +r.x || 0,
      y: +r.y || 0,
      w: Math.max(1, +r.w || 100),
      h: Math.max(1, +r.h || 100),
      color: r.color || "#c7d2fe",
      notches: (r.notches || [])
        .filter((n) => ["top", "right", "bottom", "left"].includes(n.side))
        .map((n) => normalizeNotch(n, true)),
      openings: (r.openings || [])
        .filter((o) => ["top", "right", "bottom", "left"].includes(o.side))
        .map((o) => ({
          id: o.id || uid("op"),
          type: o.type === "window" ? "window" : "door",
          side: o.side,
          // Optional: id of the cut-out/cut-in this opening sits on, and which
          // edge of it (front face or one of the two sides).
          notch: o.notch ? String(o.notch) : null,
          notchEdge: ["side1", "side2"].includes(o.notchEdge) ? o.notchEdge : "face",
          hinge: o.hinge === "end" ? "end" : "start",
          swing: o.swing === "in" ? "in" : "out",
          // "no" = an open doorway: the opening (and any frame) still shows, but
          // there's no leaf or swing arc.
          leaf: o.leaf === "no" ? "no" : "yes",
          gap: Math.max(0, Math.round(+o.gap || 0)),
          width: Math.max(1, Math.round(+o.width || 80)),
          // Door frame width on *each* side: stays marked on the wall as part of
          // the door, but the swinging leaf only spans width - 2*frame.
          frame: Math.max(0, Math.round(+o.frame || 0)),
        })),
      objects: (r.objects || []).map((o) => ({
        id: o.id || uid("o"),
        name: o.name || "Object",
        x: +o.x || 0,
        y: +o.y || 0,
        w: Math.max(1, +o.w || 50),
        h: Math.max(1, +o.h || 50),
        rot: [0, 90, 180, 270].includes(+o.rot) ? +o.rot : 0,
        color: o.color || "#94a3b8",
      })),
      // Wall-mounted electrics (sockets / switches). `d` is the distance in cm
      // along the room outline perimeter; `face` in = into the room, out = the
      // external wall face.
      electrics: (r.electrics || []).map((e) => ({
        id: e.id || uid("e"),
        kind: e.kind === "switch" ? "switch" : "socket",
        size: e.size === "double" ? "double" : "single",
        d: Math.max(0, +e.d || 0),
        face: e.face === "out" ? "out" : "in",
      })),
    };
  }

  // Coerce loaded data into the current schema. Accepts both the current
  // multi-layout shape and the older single-`rooms` shape (and hand edits).
  function normalize(data) {
    let layouts;
    if (Array.isArray(data.layouts) && data.layouts.length) {
      layouts = data.layouts.map((l) => ({
        id: l.id || uid("l"),
        name: l.name || "Layout",
        rooms: (l.rooms || []).map(normalizeRoom),
      }));
    } else {
      layouts = [{ id: uid("l"), name: "Layout 1", rooms: (data.rooms || []).map(normalizeRoom) }];
    }
    const activeId = layouts.some((l) => l.id === data.activeId) ? data.activeId : layouts[0].id;
    const writers = data.writers && typeof data.writers === "object" ? data.writers : {};
    // Missing rev/updatedAt stay 0 so an untouched copy can't outrank real data.
    return { version: SCHEMA_VERSION, rev: +data.rev || 0, updatedAt: +data.updatedAt || 0, activeId, layouts, writers };
  }

  // Replace the whole document with one pulled from Drive, without bumping the
  // timestamp or re-triggering a sync (that would fight the newest-wins logic).
  function applyRemoteDoc(remoteDoc) {
    suppressSync = true;
    doc = remoteDoc;
    state = activeLayout();
    selection = null;
    try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {}
    suppressSync = false;
    resetHistory(); // a remote replacement is a new baseline, not an undo step
    renderLayoutBar();
    render();
    refreshPanel();
  }

  function activeLayout() {
    return doc.layouts.find((l) => l.id === doc.activeId) || doc.layouts[0];
  }

  let saveTimer = null;
  let pendingSave = false; // a debounced edit is waiting to be written
  let suppressSync = false; // true while applying a remote doc, to avoid loops

  // Write to localStorage + schedule a Drive sync, bumping the skew-proof
  // revision. Does NOT touch undo history (used by undo/redo replay too).
  function persist() {
    if (!suppressSync) {
      doc.rev = DRIVE.nextRev();
      doc.updatedAt = Date.now();
    }
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
    } catch (_) {}
    if (!suppressSync) DRIVE.scheduleSync();
  }
  function save() {
    pendingSave = false;
    persist();
    if (!suppressSync) recordHistory();
  }
  function saveSoon() {
    pendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }
  // Flush an outstanding debounced save (on tab hide/close). Crucially does
  // nothing when there's no pending edit — a plain reload must NOT count as a
  // save (which would bump rev/updatedAt and let a stale copy win newest-wins).
  function flushPendingSave() {
    if (!pendingSave) return;
    clearTimeout(saveTimer);
    save();
  }

  // ---- Undo / redo: snapshots of plan content captured at each save ----
  const HISTORY_LIMIT = 80;
  let undoStack = [];
  let redoStack = [];
  let lastSnap = null;
  const contentSnap = () => JSON.stringify({ activeId: doc.activeId, layouts: doc.layouts });
  function recordHistory() {
    const snap = contentSnap();
    if (snap === lastSnap) return;
    if (lastSnap !== null) {
      undoStack.push(lastSnap);
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    }
    redoStack.length = 0;
    lastSnap = snap;
    updateHistoryButtons();
  }
  function resetHistory() {
    undoStack = [];
    redoStack = [];
    lastSnap = contentSnap();
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    const u = el("btn-undo"), r = el("btn-redo");
    if (u) u.disabled = !undoStack.length;
    if (r) r.disabled = !redoStack.length;
  }
  function applyHistory(snap) {
    const data = JSON.parse(snap);
    doc.activeId = data.activeId;
    doc.layouts = data.layouts;
    lastSnap = snap;
    state = activeLayout();
    selection = null;
    persist(); // save + sync, but don't create a new history step
    renderLayoutBar();
    render();
    refreshPanel();
    updateHistoryButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(lastSnap);
    applyHistory(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(lastSnap);
    applyHistory(redoStack.pop());
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return normalize(data);
    } catch (_) {
      return null;
    }
  }

  function sample() {
    const layoutId = uid("l");
    return {
      version: SCHEMA_VERSION,
      // rev/updatedAt 0 mark this as an untouched default: it must never outrank a
      // real plan in Drive on first sync. The first real edit stamps it via save().
      rev: 0,
      updatedAt: 0,
      activeId: layoutId,
      layouts: [
        {
          id: layoutId,
          name: "Layout 1",
          rooms: [
            {
              id: uid("r"),
              name: "Living Room",
              x: 0,
              y: 0,
              w: 450,
              h: 360,
              color: PALETTE[0],
              objects: [
                { id: uid("o"), name: "Sofa", x: 30, y: 240, w: 220, h: 90, rot: 0, color: "#94a3b8" },
                { id: uid("o"), name: "TV unit", x: 40, y: 20, w: 180, h: 45, rot: 0, color: "#a8a29e" },
                { id: uid("o"), name: "Coffee table", x: 120, y: 150, w: 110, h: 60, rot: 0, color: "#d6bcab" },
              ],
            },
          ],
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Google Drive sync (optional, hosted-site only)
  //
  // Uses Google Identity Services for OAuth (token model — no client secret) and
  // the Drive REST API with the least-privilege `drive.file` scope, so the app
  // can only ever see the single `floorplan.json` it creates. Conflicts resolve
  // by newest-wins using the document's `updatedAt` timestamp.
  // ---------------------------------------------------------------------------
  const DRIVE = (() => {
    const SCOPE = "https://www.googleapis.com/auth/drive.file";
    const FILE_NAME = "floorplan.json";
    // Baked-in default OAuth Client ID for this deployment. A Client ID is not a
    // secret (it ships in client-side code by design); the consent screen and the
    // authorised-origins allowlist are what protect it. Forks can override it via
    // the in-app field, which is stored in localStorage and takes precedence.
    const DEFAULT_CLIENT_ID = "570993263806-e6ga4lb5137114grenq6ucjtmq159o4q.apps.googleusercontent.com";
    // No Google API / developer key: the Picker authenticates with the OAuth
    // token alone (sufficient for a drive.file picker), so the app needs no API
    // key at all. Earlier builds baked one in and let users enter their own,
    // stored under "floorplan.drive.apiKey"; that key is gone now, so we just
    // purge any leftover stored value below.
    const LS = {
      clientId: "floorplan.drive.clientId",
      fileId: "floorplan.drive.fileId",
      connected: "floorplan.drive.connected",
      auto: "floorplan.drive.auto",
      lastRev: "floorplan.drive.lastRev",
      sharedFile: "floorplan.drive.sharedFile",
    };

    let clientId = localStorage.getItem(LS.clientId) || DEFAULT_CLIENT_ID;
    // Clean up the now-unused API key some browsers still have stored.
    try { localStorage.removeItem("floorplan.drive.apiKey"); } catch (_) {}

    // Stable per-device id + editable label, written into the file so every
    // client can show who last wrote and when.
    const CLIENT_ID = (() => {
      let id = localStorage.getItem("floorplan.clientId");
      if (!id) { id = uid("c"); try { localStorage.setItem("floorplan.clientId", id); } catch (_) {} }
      return id;
    })();
    let clientName = localStorage.getItem("floorplan.clientName") || "";
    // Best-effort device description from the browser. The browser/OS are
    // detectable; specific hardware (e.g. "MacBook Air M1", "iPhone 13 mini")
    // is not exposed for privacy, so users can override via the name field.
    function deviceDescription() {
      const ua = navigator.userAgent || "";
      let browser = "Browser";
      if (/\bEdg\//.test(ua)) browser = "Edge";
      else if (/\bOPR\/|Opera/.test(ua)) browser = "Opera";
      else if (/Firefox\//.test(ua)) browser = "Firefox";
      else if (/Chrome\//.test(ua)) browser = "Chrome";
      else if (/Safari\//.test(ua)) browser = "Safari";
      let os = "";
      if (/iPhone/.test(ua)) os = "iPhone";
      else if (/iPad/.test(ua)) os = "iPad";
      else if (/Android/.test(ua)) os = "Android";
      else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
      else if (/Windows/.test(ua)) os = "Windows";
      else if (/CrOS/.test(ua)) os = "ChromeOS";
      else if (/Linux/.test(ua)) os = "Linux";
      return os ? browser + " on " + os : browser;
    }
    const clientLabel = () => clientName || deviceDescription();
    // The signed-in Google account (so collaborators see *who* edited a shared
    // file, not just which device). Populated from the Drive API.
    let driveUser = null; // { name, email }
    async function fetchDriveUser() {
      try {
        const res = await api("https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)");
        const d = await res.json();
        if (d && d.user) driveUser = { name: d.user.displayName || "", email: d.user.emailAddress || "" };
      } catch (_) { /* leave null; we'll just show the device */ }
    }
    function stampWriter() {
      if (!doc.writers || typeof doc.writers !== "object") doc.writers = {};
      const entry = { name: clientLabel(), at: Date.now(), rev: +doc.rev || 0 };
      if (driveUser) { entry.user = driveUser.name || ""; entry.email = driveUser.email || ""; }
      doc.writers[CLIENT_ID] = entry;
    }
    function mergeWriters(a, b) {
      const out = {};
      for (const src of [a, b]) {
        if (src && typeof src === "object") {
          for (const k in src) {
            const e = src[k];
            if (e && (!out[k] || (e.at || 0) > (out[k].at || 0))) out[k] = e;
          }
        }
      }
      return out;
    }
    // When set, we sync against this specific (typically link-shared) file the
    // user picked with the Google Picker, instead of their own floorplan.json.
    let sharedFileId = localStorage.getItem(LS.sharedFile) || "";
    let fileId = localStorage.getItem(LS.fileId) || "";
    let connected = localStorage.getItem(LS.connected) === "1";
    let auto = localStorage.getItem(LS.auto) !== "0";
    let lastSeenRev = +localStorage.getItem(LS.lastRev) || 0;
    // Cache the OAuth access token in sessionStorage so a reload *within the same
    // tab* reuses it and skips the Google account chooser. sessionStorage is
    // scoped to the tab and cleared when the tab closes, so the token never
    // lingers on the device or leaks to other tabs. Tokens last ~1h; after that
    // the user picks an account again (once), then it's cached for the tab again.
    const TOKEN_SS_KEY = "floorplan.drive.token";
    let token = null;
    let tokenExp = 0;
    (function restoreToken() {
      try {
        const t = JSON.parse(sessionStorage.getItem(TOKEN_SS_KEY) || "null");
        if (t && t.cid === clientId && t.token && Date.now() < t.exp - 60000) {
          token = t.token; tokenExp = t.exp;
        } else if (t) {
          sessionStorage.removeItem(TOKEN_SS_KEY);
        }
      } catch (_) {}
    })();
    function persistToken() {
      try {
        if (token) sessionStorage.setItem(TOKEN_SS_KEY, JSON.stringify({ cid: clientId, token, exp: tokenExp }));
        else sessionStorage.removeItem(TOKEN_SS_KEY);
      } catch (_) {}
    }
    function clearToken() { token = null; tokenExp = 0; persistToken(); }
    let tokenClient = null;
    let busy = false;
    let timer = null;
    // Chosen each load via the first-load prompt: "drive" syncs this session,
    // "local" works only on this device. Defaults to local so nothing pushes to
    // Drive until the user opts in.
    let sessionMode = "local";
    // Set once a write to the pinned shared file is rejected (403) because the
    // user only has read access. We then stop trying to push automatically and
    // explain that edits stay on this device; a manual Sync re-tests access.
    let sharedReadOnly = false;

    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
    function setLastSeenRev(r) { lastSeenRev = Math.max(lastSeenRev, +r || 0); lsSet(LS.lastRev, String(lastSeenRev)); markSaved(); }
    // Every sync success runs through setLastSeenRev, so this is when local and
    // Drive are in step.
    let lastSavedAt = 0;
    function markSaved() { lastSavedAt = Date.now(); pill(); }
    function agoText(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return s + "s ago";
      const m = Math.round(s / 60);
      if (m < 60) return m + "m ago";
      const h = Math.round(m / 60);
      return h < 24 ? h + "h ago" : Math.round(h / 24) + "d ago";
    }
    // Monotonic revision for the next local edit (Lamport clock): always greater
    // than any revision this device has observed, so ordering survives clock skew.
    function nextRev() { return Math.max(+doc.rev || 0, lastSeenRev) + 1; }

    function setStatus(msg, kind) {
      const node = el("drive-status");
      if (node) {
        node.textContent = msg || "";
        node.className = "drive-status" + (kind ? " " + kind : "");
      }
    }
    function pill() {
      const b = el("btn-drive");
      if (!b) return;
      b.classList.toggle("active", connected);
      b.textContent = "☁ Drive sync" + (lastSavedAt ? " · saved " + agoText(Date.now() - lastSavedAt) : "");
      b.title = connected ? "Google Drive: connected" : "Google Drive: not connected";
    }
    function updateUI() {
      el("drive-auto").checked = auto;
      el("drive-connect").hidden = connected;
      el("drive-disconnect").hidden = !connected;
      el("drive-syncnow").hidden = !connected;
      el("drive-force-row").hidden = !connected;
      const pick = el("drive-pick");
      if (pick) pick.hidden = !connected;
      const sharedRow = el("drive-shared-row");
      if (sharedRow) sharedRow.hidden = !sharedFileId;
      const nameInput = el("drive-clientname");
      if (nameInput) {
        nameInput.placeholder = deviceDescription(); // shown when left blank
        if (document.activeElement !== nameInput) nameInput.value = clientName;
      }
      renderWriters();
      pill();
    }

    // Show who last wrote to the file and when. Names come from other clients,
    // so build with textContent (never innerHTML) to stay XSS-safe.
    function renderWriters() {
      const box = el("drive-writers");
      if (!box) return;
      const w = doc.writers && typeof doc.writers === "object" ? doc.writers : {};
      const entries = Object.entries(w).filter(([, e]) => e && e.at).sort((a, b) => b[1].at - a[1].at);
      box.replaceChildren();
      if (!entries.length) { box.hidden = true; return; }
      box.hidden = false;
      const h = document.createElement("h3");
      h.textContent = "Last edits";
      box.appendChild(h);
      for (const [id, e] of entries) {
        const row = document.createElement("div");
        row.className = "writer-row";
        const who = (e.name ? String(e.name) : "Device") + (id === CLIENT_ID ? " (this device)" : "");
        const u = e.user || e.email ? " · " + String(e.user || e.email) : "";
        row.textContent = who + u + " · " + new Date(e.at).toLocaleString();
        box.appendChild(row);
      }
    }

    function gisReady() {
      return !!(window.google && google.accounts && google.accounts.oauth2);
    }
    function waitForGis(cb, tries = 25) {
      if (gisReady()) return cb(true);
      if (tries <= 0) return cb(false);
      setTimeout(() => waitForGis(cb, tries - 1), 200);
    }

    // Acquire an access token. interactive=true is allowed to show UI/consent.
    function getToken(interactive) {
      return new Promise((resolve, reject) => {
        if (token && Date.now() < tokenExp - 60000) return resolve(token);
        if (!gisReady()) return reject(new Error("Google sign-in library not loaded"));
        if (!clientId) return reject(new Error("Set your OAuth Client ID first"));
        if (!tokenClient || tokenClient.__cid !== clientId) {
          tokenClient = google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
          tokenClient.__cid = clientId;
        }
        tokenClient.callback = (resp) => {
          if (resp && resp.error) return reject(new Error(resp.error_description || resp.error));
          token = resp.access_token;
          tokenExp = Date.now() + (resp.expires_in ? resp.expires_in * 1000 : 3600000);
          persistToken();
          resolve(token);
        };
        try {
          tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
        } catch (e) {
          reject(e);
        }
      });
    }

    async function api(url, opts, interactive) {
      const t = await getToken(interactive);
      let res = await fetch(url, withAuth(opts, t));
      if (res.status === 401) {
        clearToken();
        const t2 = await getToken(true);
        res = await fetch(url, withAuth(opts, t2));
      }
      if (!res.ok) throw new Error("Drive API " + res.status);
      return res;
    }
    function withAuth(opts, t) {
      const o = opts || {};
      return { ...o, headers: { ...(o.headers || {}), Authorization: "Bearer " + t } };
    }

    // List *all* copies of the plan the app can see. Earlier bugs (and two
    // devices connecting before either's file was indexed) can leave duplicate
    // `floorplan.json` files; we reconcile them rather than trust a stored id.
    async function listFiles() {
      const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
      const res = await api(
        `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&orderBy=createdTime&fields=files(id,createdTime,modifiedTime)`
      );
      const data = await res.json();
      return data.files || [];
    }
    const tms = (s) => (s ? new Date(s).getTime() || 0 : 0);
    async function downloadFile(id) {
      const res = await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`);
      return res.text();
    }
    async function createFile(content) {
      const boundary = "flp" + Math.random().toString(36).slice(2);
      const meta = { name: FILE_NAME, mimeType: "application/json" };
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await api(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      });
      const data = await res.json();
      return data.id;
    }
    async function updateFile(id, content) {
      await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: content,
      });
    }

    // mode: "auto" | "firstConnect" | "forceUp" | "forceDown"
    async function syncNow(interactive, mode) {
      if (!connected || busy) return;
      if (interactive) sharedReadOnly = false; // an explicit Sync/Force re-tests write access
      sessionMode = "drive"; // any sync means we're working against Drive
      busy = true;
      setStatus("Syncing…");
      try {
        await getToken(interactive);
        if (!driveUser) await fetchDriveUser(); // so writes record who, not just the device

        // Pinned to a shared file -> sync only against that one file.
        if (sharedFileId) { await syncSharedFile(mode); return; }

        const files = await listFiles();

        // No file yet -> create one from the local plan.
        if (files.length === 0) {
          stampWriter();
          fileId = await createFile(serialize());
          lsSet(LS.fileId, fileId);
          setLastSeenRev(+doc.rev || 0);
          try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {}
          setStatus("Saved to Drive · " + timeNow());
          pill();
          return;
        }

        // Canonical = earliest-created copy (deterministic across devices).
        files.sort((a, b) => tms(a.createdTime) - tms(b.createdTime));
        const canonical = files[0].id;
        fileId = canonical;
        lsSet(LS.fileId, canonical);

        // Read every copy; the winner is the highest revision (then newest time).
        let best = null;
        for (const f of files) {
          try {
            const d = JSON.parse(await downloadFile(f.id));
            const rev = +d.rev || 0;
            const at = +d.updatedAt || 0;
            if (!best || rev > best.rev || (rev === best.rev && at > best.at)) best = { id: f.id, doc: d, rev, at };
          } catch (_) {}
        }
        const note = files.length > 1 ? " · merged " + files.length + " copies" : "";
        const localRev = +doc.rev || 0;
        const remoteRev = best ? best.rev : 0;

        const pull = async (label) => {
          applyRemoteDoc(normalize(best.doc));
          setLastSeenRev(remoteRev);
          if (best.id !== canonical) await updateFile(canonical, serialize()); // converge onto canonical
          setStatus(label + note + " · " + timeNow());
        };
        const push = async (label) => {
          doc.writers = mergeWriters(best && best.doc.writers, doc.writers);
          stampWriter();
          await updateFile(canonical, serialize());
          setLastSeenRev(+doc.rev || 0);
          try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {} // keep local writers in step
          setStatus(label + note + " · " + timeNow());
        };

        if (mode === "forceDown") {
          if (best) await pull("Loaded from Drive");
          else setStatus("Nothing in Drive yet" + note);
        } else if (mode === "forceUp") {
          doc.rev = Math.max(localRev, remoteRev) + 1; // guarantee this device wins
          try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {}
          await push("Uploaded to Drive");
        } else if (best && remoteRev > localRev) {
          await pull("Updated from Drive");
        } else if (localRev > remoteRev) {
          if (mode === "firstConnect" && best) {
            const ok = confirm(
              "This device has changes that are newer than the plan already in Google Drive.\n\n" +
                "OK — overwrite Drive with this device's version.\n" +
                "Cancel — discard this device's changes and load the version from Drive."
            );
            if (!ok) { await pull("Loaded from Drive"); pill(); return; }
          }
          await push("Saved to Drive");
        } else {
          // Same revision. Make sure the canonical copy holds it if duplicates exist.
          setLastSeenRev(remoteRev);
          if (files.length > 1) await updateFile(canonical, serialize());
          setStatus("Up to date" + note + " · " + timeNow());
        }
        pill();
      } catch (e) {
        // A missing file (e.g. deleted in Drive) — drop the id and recreate next time.
        if (/Drive API 404/.test(e.message)) { fileId = ""; lsSet(LS.fileId, ""); }
        setStatus("Sync error: " + e.message, "err");
      } finally {
        busy = false;
      }
    }

    // Sync against a single shared file (picked via the Google Picker), so
    // multiple people with edit access to one Drive file collaborate on it.
    // Same newest-wins (by rev) rules as the personal-file path.
    async function syncSharedFile(mode) {
      let remote = null;
      try {
        remote = JSON.parse(await downloadFile(sharedFileId));
      } catch (e) {
        if (/Drive API 404|Drive API 403/.test(e.message)) {
          setStatus("Lost access to the shared plan. Pick it again.", "err");
          sharedFileId = ""; lsSet(LS.sharedFile, "");
          updateUI();
          return;
        }
        throw e;
      }
      const localRev = +doc.rev || 0;
      const remoteRev = remote ? +remote.rev || 0 : 0;
      const pull = async (label) => {
        applyRemoteDoc(normalize(remote));
        setLastSeenRev(remoteRev);
        setStatus(label + " · " + timeNow());
      };
      const push = async (label) => {
        doc.writers = mergeWriters(remote && remote.writers, doc.writers);
        stampWriter();
        try {
          await updateFile(sharedFileId, serialize());
        } catch (e) {
          if (/Drive API 403/.test(e.message)) {
            // The user can read this shared file but not write it.
            sharedReadOnly = true;
            setStatus("Read-only access — your changes are kept on this device but can't be saved to the shared plan.", "err");
            pill();
            return;
          }
          throw e;
        }
        sharedReadOnly = false;
        setLastSeenRev(+doc.rev || 0);
        try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {}
        setStatus(label + " · " + timeNow());
      };
      if (mode === "forceDown") {
        if (remote) await pull("Loaded shared plan");
        else setStatus("Shared file is empty.");
      } else if (mode === "forceUp") {
        doc.rev = Math.max(localRev, remoteRev) + 1;
        try { localStorage.setItem(STORAGE_KEY, serialize()); } catch (_) {}
        await push("Uploaded to shared plan");
      } else if (remote && remoteRev > localRev) {
        await pull("Updated from shared plan");
      } else if (localRev > remoteRev) {
        // Known read-only: don't hammer Drive with doomed writes on every edit;
        // just remind the user. A manual Sync clears the flag and re-tests.
        if (sharedReadOnly) setStatus("Read-only — local changes stay on this device only.", "err");
        else await push("Saved to shared plan");
      } else {
        setLastSeenRev(remoteRev);
        setStatus("Shared plan up to date · " + timeNow());
      }
      pill();
    }

    function timeNow() {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function scheduleSync() {
      if (sessionMode !== "drive" || !connected || !auto) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncNow(false, "auto"), 2500);
    }

    // First-load choices. "Work locally" keeps everything on this device this
    // session; "Use Drive" pulls the latest (or opens the connect dialog).
    function useLocal() {
      sessionMode = "local";
      setStatus("Working on this device.");
    }
    function useDrive() {
      sessionMode = "drive";
      // Leaving any shared-file pin: this path is the user's *personal* Drive.
      if (sharedFileId) { sharedFileId = ""; lsSet(LS.sharedFile, ""); }
      if (!clientId) { open(); return; }
      if (!connected) { open(); connect(); return; }
      waitForGis((ok) => {
        if (!ok) { open(); return; }
        getToken(false).then(() => connectChoice("Google Drive")).catch(() => { open(); connect(); });
      });
    }
    function openShared() {
      sessionMode = "drive";
      open();
      openPicker();
    }

    async function authenticate() {
      if (!clientId) throw new Error("No OAuth Client ID configured");
      if (!gisReady()) throw new Error("Google library not loaded — check your connection");
      await getToken(true);
      connected = true;
      lsSet(LS.connected, "1");
      updateUI();
    }

    // Read the current winning remote doc for the active target (a pinned shared
    // file, or the canonical personal file), or null if there isn't one.
    async function fetchRemoteDoc() {
      if (sharedFileId) {
        try { return JSON.parse(await downloadFile(sharedFileId)); }
        catch (e) { if (/Drive API 40[34]/.test(e.message)) return null; throw e; }
      }
      const files = await listFiles();
      if (!files.length) return null;
      let best = null;
      for (const f of files) {
        try {
          const d = JSON.parse(await downloadFile(f.id));
          const rev = +d.rev || 0, at = +d.updatedAt || 0;
          if (!best || rev > best.rev || (rev === best.rev && at > best.at)) best = { doc: d, rev, at };
        } catch (_) {}
      }
      return best ? best.doc : null;
    }
    // Most recent write recorded in a doc: { at, who, id, user }.
    function lastEdit(d) {
      const w = d && d.writers && typeof d.writers === "object" ? d.writers : {};
      let best = null;
      for (const k in w) {
        const e = w[k];
        if (e && e.at && (!best || e.at > best.at)) best = { at: e.at, who: e.name, id: k, user: e.user || e.email };
      }
      return best || { at: +((d && d.updatedAt) || 0), who: "a device", id: null };
    }
    function fmtEdit(info) {
      if (!info || !info.at) return "was last saved at an unknown time";
      const dev = (info.who || "a device") + (info.id === CLIENT_ID ? " — this device" : "");
      const u = info.user ? " (" + info.user + ")" : "";
      return "was last saved " + new Date(info.at).toLocaleString() + " by " + dev + u;
    }
    function olderBy(ms) {
      const s = Math.max(1, Math.round(ms / 1000));
      const pick = (n, unit) => n + " " + unit + (n === 1 ? "" : "s") + " older";
      if (s < 60) return pick(s, "second");
      if (s < 3600) return pick(Math.round(s / 60), "minute");
      if (s < 86400) return pick(Math.round(s / 3600), "hour");
      return pick(Math.round(s / 86400), "day");
    }

    // On connecting to a target (personal Drive or a shared file): if local and
    // remote already match, just align and continue; otherwise ask which to keep,
    // showing when each was last saved and by which device.
    let directionResolve = null;
    async function connectChoice(label) {
      setStatus("Checking…");
      if (!driveUser) await fetchDriveUser();
      let remote;
      try { remote = await fetchRemoteDoc(); }
      catch (e) { setStatus("Sync error: " + e.message, "err"); return; }
      if (!remote) return syncNow(false, "forceUp"); // nothing there yet — just upload

      // Compare *normalised* content on both sides. The local doc is always
      // normalised; normalising the remote too means a file written by an older
      // app version (missing newer fields) still counts as "in sync" instead of
      // looping the dialog forever.
      const nr = normalize(remote);
      const localContent = JSON.stringify({ activeId: doc.activeId, layouts: doc.layouts });
      const remoteContent = JSON.stringify({ activeId: nr.activeId, layouts: nr.layouts });
      if (localContent === remoteContent) {
        setLastSeenRev(+remote.rev || 0);
        setStatus("Already in sync · " + timeNow());
        return;
      }

      el("direction-title").textContent = "Working with " + label;
      const localAt = +doc.updatedAt || 0;
      const remoteAt = lastEdit(remote).at || +remote.updatedAt || 0;
      const localNewer = localAt >= remoteAt;
      el("direction-up-tag").textContent = localNewer ? "(newest)" : "(" + olderBy(remoteAt - localAt) + ")";
      el("direction-down-tag").textContent = localNewer ? "(" + olderBy(localAt - remoteAt) + ")" : "(newest)";
      el("direction-local").textContent = "This device " + fmtEdit({ at: localAt, who: clientLabel(), id: CLIENT_ID, user: driveUser ? driveUser.name || driveUser.email : "" });
      el("direction-remote").textContent = "Saved copy " + fmtEdit(lastEdit(remote));
      el("direction-modal").hidden = false;
      const dir = await new Promise((resolve) => { directionResolve = resolve; });
      if (dir) return syncNow(false, dir);
    }
    function resolveDirection(dir) {
      el("direction-modal").hidden = true;
      const r = directionResolve;
      directionResolve = null;
      if (r) r(dir);
    }

    async function connect() {
      try {
        setStatus("Connecting…");
        await authenticate();
        await connectChoice("Google Drive");
      } catch (e) {
        setStatus("Could not connect: " + e.message, "err");
      }
    }

    function disconnect() {
      try {
        if (token && gisReady() && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(token, () => {});
      } catch (_) {}
      clearToken();
      connected = false;
      lsSet(LS.connected, "0");
      updateUI();
      setStatus("Disconnected.");
    }

    // ---- Shared file via the Google Picker ----
    // With the drive.file scope, the app can only touch files it created or that
    // the user explicitly opens with the Picker. So to collaborate on one shared
    // file, each person picks it here (they must already have edit access via the
    // Drive share link), which grants this app access to that single file.
    function pickerReady() {
      return !!(window.google && google.picker);
    }
    function loadPicker(cb) {
      if (pickerReady()) return cb(true);
      if (!window.gapi) return cb(false);
      try { gapi.load("picker", { callback: () => cb(pickerReady()) }); } catch (_) { cb(false); }
    }
    async function openPicker() {
      sessionMode = "drive";
      if (!clientId) { setStatus("No OAuth Client ID configured.", "err"); return; }
      try {
        if (!connected) { setStatus("Connecting…"); await authenticate(); }
      } catch (e) { setStatus("Could not connect: " + e.message, "err"); return; }
      getToken(false)
        .then((t) => {
          loadPicker((ok) => {
            if (!ok) { setStatus("Couldn't load the Google Picker (offline?).", "err"); return; }
            const appId = clientId.split("-")[0];
            const mine = new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setMimeTypes("application/json").setOwnedByMe(true);
            const shared = new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setMimeTypes("application/json").setOwnedByMe(false);
            const builder = new google.picker.PickerBuilder()
              .setOAuthToken(t)
              .setAppId(appId)
              .setTitle("Open a shared floor plan")
              .addView(mine)
              .addView(shared)
              .setCallback(pickerCallback);
            // No setDeveloperKey: for an OAuth-token drive.file picker the API key
            // is optional, and a key whose project restrictions Google dislikes is
            // exactly what triggers "The API developer key is invalid". The OAuth
            // token + appId are sufficient to open files the user picks.
            builder.build().setVisible(true);
          });
        })
        .catch((e) => setStatus("Picker error: " + e.message, "err"));
    }
    function pickerCallback(data) {
      const P = window.google && google.picker;
      if (!P || !data || data.action !== P.Action.PICKED) return;
      const f = data.docs && data.docs[0];
      if (!f) return;
      sharedFileId = f.id;
      sharedReadOnly = false;
      lsSet(LS.sharedFile, sharedFileId);
      connected = true; lsSet(LS.connected, "1");
      updateUI();
      connectChoice("the shared plan"); // choose: upload local, or load the shared file
    }
    function leaveShared() {
      sharedFileId = "";
      sharedReadOnly = false;
      lsSet(LS.sharedFile, "");
      updateUI();
      setStatus("Back to your own plan. Sync to load it.");
    }

    function open() {
      updateUI();
      if (!el("drive-status").textContent) {
        setStatus(connected ? "Connected." : "Ready to connect.");
      }
      el("drive-modal").hidden = false;
    }
    function close() { el("drive-modal").hidden = true; }

    function bindEvents() {
      el("btn-drive").addEventListener("click", open);
      el("drive-close").addEventListener("click", close);
      el("drive-modal").addEventListener("click", (e) => { if (e.target.id === "drive-modal") close(); });
      el("drive-connect").addEventListener("click", connect);
      el("drive-disconnect").addEventListener("click", disconnect);
      el("drive-syncnow").addEventListener("click", () => syncNow(true, "auto"));
      el("drive-pick").addEventListener("click", openPicker);
      el("drive-leave-shared").addEventListener("click", leaveShared);
      el("drive-clientname").addEventListener("input", (e) => {
        clientName = e.target.value.trim();
        lsSet("floorplan.clientName", clientName);
      });
      el("direction-upload").addEventListener("click", () => resolveDirection("forceUp"));
      el("direction-load").addEventListener("click", () => resolveDirection("forceDown"));
      el("direction-cancel").addEventListener("click", () => resolveDirection(null));
      el("direction-modal").addEventListener("click", (e) => { if (e.target.id === "direction-modal") resolveDirection(null); });
      el("drive-force-up").addEventListener("click", () => {
        if (confirm("Overwrite the copy in Google Drive with THIS device's plan?")) syncNow(true, "forceUp");
      });
      el("drive-force-down").addEventListener("click", () => {
        if (confirm("Overwrite THIS device's plan with the copy from Google Drive?")) syncNow(true, "forceDown");
      });
      el("drive-auto").addEventListener("change", (e) => {
        auto = e.target.checked;
        lsSet(LS.auto, auto ? "1" : "0");
        if (auto) scheduleSync();
      });
    }

    function boot() {
      bindEvents();
      updateUI();
      setInterval(() => { if (lastSavedAt) pill(); }, 15000); // keep "saved N ago" fresh
      // Loading from Drive is now driven by the first-load prompt (useDrive),
      // so the user consciously chooses Drive vs local on every load.
    }

    return { scheduleSync, boot, nextRev, open, useLocal, useDrive, openShared };
  })();

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, select, textarea");
    if (typing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
    const r = resolveSel();
    if ((e.key === "Delete" || e.key === "Backspace") && r) { e.preventDefault(); deleteSel(); }
    else if (e.key.toLowerCase() === "r" && r && r.kind === "object") { rotateSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && r) { e.preventDefault(); duplicateSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && r) { e.preventDefault(); copySel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) { e.preventDefault(); pasteClipboard(); }
    else if (e.key === "Escape") select(null);
    else if (e.key.startsWith("Arrow") && r) {
      e.preventDefault();
      const step = e.shiftKey ? ui.gridCm * 10 : ui.gridCm;
      if (e.key === "ArrowLeft") r.item.x -= step;
      if (e.key === "ArrowRight") r.item.x += step;
      if (e.key === "ArrowUp") r.item.y -= step;
      if (e.key === "ArrowDown") r.item.y += step;
      save();
      render();
      refreshPanel();
    }
  });

  // ---------------------------------------------------------------------------
  // Wire up toolbar
  // ---------------------------------------------------------------------------
  el("btn-lock").addEventListener("click", () => setLocked(!locked));
  el("btn-undo").addEventListener("click", undo);
  el("btn-redo").addEventListener("click", redo);
  el("btn-add-room").addEventListener("click", addRoom);
  el("btn-add-object").addEventListener("click", addObject);
  el("btn-add-electric").addEventListener("click", addElectric);
  el("btn-electric-done").addEventListener("click", () => select(null));
  const electricSet = (key, val) => {
    const r = resolveSel();
    if (r && r.kind === "electric") { r.elec[key] = val; save(); render(); }
  };
  el("electric-kind").addEventListener("change", (e) => electricSet("kind", e.target.value));
  el("electric-size").addEventListener("change", (e) => electricSet("size", e.target.value));
  el("electric-face").addEventListener("change", (e) => electricSet("face", e.target.value));
  el("btn-laser").addEventListener("click", toggleLaser);
  el("btn-laser-done").addEventListener("click", () => { if (laser) toggleLaser(); });
  const laserSet = (key, val) => { if (laser) { laser[key] = val; render(); el("laser-readout").textContent = laserReadout(); } };
  el("laser-target").addEventListener("change", (e) => laserSet("target", e.target.value));
  el("laser-axis").addEventListener("change", (e) => laserSet("axis", e.target.value));
  el("laser-dir").addEventListener("change", (e) => laserSet("dir", parseInt(e.target.value, 10)));
  el("laser-mode").addEventListener("change", (e) => laserSet("mode", e.target.value));
  el("btn-rotate").addEventListener("click", rotateSel);
  el("btn-duplicate").addEventListener("click", duplicateSel);
  el("btn-delete").addEventListener("click", deleteSel);
  el("btn-deselect").addEventListener("click", () => select(null));
  el("btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
  el("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
  el("btn-zoom-reset").addEventListener("click", fitView);
  el("zoom-select").addEventListener("change", (e) => {
    const v = e.target.value;
    if (v === "fit") fitView();
    else if (v !== "__current") zoomTo(+v / 100);
    e.target.blur();
  });
  el("chk-room-edges").addEventListener("change", (e) => { ui.roomEdges = e.target.checked; saveUiPrefs(); render(); });
  el("chk-obj-edges").addEventListener("change", (e) => { ui.objEdges = e.target.checked; saveUiPrefs(); render(); });
  el("chk-objects").addEventListener("change", (e) => { ui.objects = e.target.checked; saveUiPrefs(); render(); });
  el("chk-electrics").addEventListener("change", (e) => { ui.electrics = e.target.checked; saveUiPrefs(); render(); });
  el("chk-grid").addEventListener("change", (e) => { ui.grid = e.target.checked; saveUiPrefs(); render(); });
  el("chk-snap").addEventListener("change", (e) => { ui.snap = e.target.checked; saveUiPrefs(); });
  el("chk-area").addEventListener("change", (e) => { ui.area = e.target.checked; saveUiPrefs(); render(); });
  el("btn-export").addEventListener("click", exportPlan);
  el("btn-import").addEventListener("click", () => el("file-import").click());
  el("file-import").addEventListener("change", (e) => {
    if (e.target.files[0]) importPlan(e.target.files[0]);
    e.target.value = "";
  });
  el("btn-clear").addEventListener("click", () => {
    if (!confirm(`Empty the current layout "${state.name}"? This cannot be undone.`)) return;
    state.rooms = [];
    selection = null;
    save();
    render();
    refreshPanel();
  });

  // Wall features
  el("btn-add-inset").addEventListener("click", () => addNotch("inset"));
  el("btn-add-outset").addEventListener("click", () => addNotch("outset"));
  el("btn-add-door").addEventListener("click", () => addOpening("door"));
  el("btn-add-window").addEventListener("click", () => addOpening("window"));

  // Layout controls
  el("layout-select").addEventListener("change", (e) => setActiveLayout(e.target.value));
  el("btn-layout-dup").addEventListener("click", duplicateLayout);
  el("btn-layout-new").addEventListener("click", newLayout);
  el("btn-layout-rename").addEventListener("click", renameLayout);
  el("btn-layout-delete").addEventListener("click", deleteLayout);

  // Dismissable canvas hint (stays dismissed on this device).
  (function hint() {
    const KEY = "floorplan.hintDismissed";
    const node = el("hint");
    if (!node) return;
    if (localStorage.getItem(KEY)) { node.classList.add("dismissed"); return; }
    el("hint-close").addEventListener("click", () => {
      node.classList.add("dismissed");
      try { localStorage.setItem(KEY, "1"); } catch (_) {}
    });
  })();

  window.addEventListener("resize", render);
  // Re-render whenever the canvas area itself resizes — e.g. the bottom panel
  // collapsing on mobile grows the canvas, and the grid must fill the new space
  // (previously it stayed blank until the next pan/zoom).
  if (window.ResizeObserver) {
    let rafPending = false;
    new ResizeObserver(() => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; render(); });
    }).observe(wrap);
  }
  // Flush any debounced save if the tab is being hidden or closed.
  window.addEventListener("beforeunload", flushPendingSave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushPendingSave(); });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  doc = load() || sample();
  state = activeLayout();
  resetHistory();
  // Lock the canvas by default on touch devices, so taps to pan/zoom can't
  // accidentally move things. Desktop (fine pointer) starts unlocked.
  setLocked(window.matchMedia("(pointer: coarse)").matches);
  bindPanel();
  loadUiPrefs();      // restore Edge lengths / Grid / Snap before the first render
  syncUiControls();   // reflect the restored prefs on the toolbar checkboxes
  renderLayoutBar();
  refreshPanel();
  fitView();
  DRIVE.boot();

  // Shown on EVERY load: a deliberate choice of which state to work on —
  // sync with Google Drive, or work locally on this device.
  (function welcome() {
    const modal = el("welcome-modal");
    const close = () => { modal.hidden = true; };
    el("welcome-local").addEventListener("click", () => { DRIVE.useLocal(); close(); });
    el("welcome-drive").addEventListener("click", () => { close(); DRIVE.useDrive(); });
    el("welcome-shared").addEventListener("click", () => { close(); DRIVE.openShared(); });
    modal.hidden = false;
  })();
})();
