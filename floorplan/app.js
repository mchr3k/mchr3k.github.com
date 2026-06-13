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
  let ui = { grid: true, snap: true, edges: true, gridCm: 10 };
  /** @type {{kind:'room'|'object', roomId:string, objId?:string}|null} */
  let selection = null;

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

    const edges = [];
    for (const side of ["top", "right", "bottom", "left"]) {
      const S = SIDES[side];
      const baseCtl = S.base === "w" ? setW(item) : setH(item);
      const onSide = notches.filter((n) => n.side === side);
      edges.push(...walkEdge(S.start(item), S.dir, S.len(item), onSide, baseCtl));
    }
    return { points: edges.map((e) => e.a), edges };
  }

  // Resolve a selection into the live objects it points at.
  function resolveSel() {
    if (!selection) return null;
    const room = state.rooms.find((r) => r.id === selection.roomId);
    if (!room) return null;
    if (selection.kind === "room") return { kind: "room", room, item: room };
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

    for (const room of state.rooms) {
      drawRoom(room);
      for (const obj of room.objects) drawObject(room, obj);
    }
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

    // Room name (top-left, inside)
    const [nx, ny] = geo.corners[0];
    g.appendChild(textLabel(nx + 8, ny + 20, room.name, { weight: 700, size: 15, fill: "#1f2933" }));

    drawEdgeLabels(g, geo, room, room.id, null);
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

    g.appendChild(
      textLabel(geo.center[0], geo.center[1] + 4, obj.name, {
        weight: 600, size: 13, fill: "#1f2933", anchor: "middle",
      })
    );

    drawEdgeLabels(g, geo, obj, room.id, obj.id);
    if (sel) drawHandles(g, geo);
    svg.appendChild(g);
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

  function drawEdgeLabels(g, geo, item, roomId, objId) {
    if (!ui.edges) return;
    for (const e of geo.edges) {
      const [lx, ly] = e.labelScreen;
      const txt = `${round(e.len)} cm`;
      const wpx = txt.length * 6.6 + 8;
      const eg = svgEl("g", {
        class: "edge-label",
        "data-kind": "edge",
        "data-room": roomId,
        "data-edge": e.idx,
        style: "cursor:pointer",
      });
      if (objId) eg.setAttribute("data-obj", objId);
      eg.appendChild(
        svgEl("rect", {
          x: lx - wpx / 2, y: ly - 9, width: wpx, height: 18, rx: 4,
          fill: "#ffffff", "fill-opacity": 0.92, stroke: "#9aa1ab", "stroke-width": 1,
        })
      );
      eg.appendChild(
        svgEl(
          "text",
          {
            x: lx, y: ly + 4,
            "font-size": 11, "text-anchor": "middle", fill: "#374151",
            "font-family": "system-ui, sans-serif", style: "pointer-events:none",
          },
          txt
        )
      );
      g.appendChild(eg);
    }
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
    return !!a && !!b && a.kind === b.kind && a.roomId === b.roomId && (a.objId || null) === (b.objId || null);
  }

  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("pointermove", onPointerMove);
  svg.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("pointercancel", onPointerUp);

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

    const target = e.target.closest("[data-kind]");
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}

    if (!target || target.getAttribute("data-kind") === undefined) {
      startPan(e);
      return;
    }
    const kind = target.getAttribute("data-kind");

    if (kind === "edge") {
      openEdgeEditor(target, e);
      return;
    }

    const roomId = target.getAttribute("data-room");
    const objId = target.getAttribute("data-obj");
    const [gmx, gmy] = mousePos(e);
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

    if (drag.type === "pan") {
      view.ox = drag.startOx + (mx - drag.startMx);
      view.oy = drag.startOy + (my - drag.startMy);
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
      drag.obj.x = snapVal(drag.startX + dx);
      drag.obj.y = snapVal(drag.startY + dy);
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
    if (drag) {
      if (drag.moved) save();
      // A tap (no drag) on the already-selected item clears the selection —
      // a reliable way to deselect on touch, where empty canvas is scarce.
      else if ((drag.type === "object" || drag.type === "room") && drag.wasSelected) select(null);
    }
    drag = null;
  }

  function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
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
    select(objId ? { kind: "object", roomId, objId } : { kind: "room", roomId });

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
    input.addEventListener("blur", commit);
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
    selection = sel;
    render();
    refreshPanel();
  }

  function refreshPanel() {
    const r = resolveSel();
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

  function rotateSel() {
    const r = resolveSel();
    if (!r || r.kind !== "object") return;
    r.item.rot = ((r.item.rot || 0) + 90) % 360;
    save();
    render();
    refreshPanel();
  }

  function duplicateSel() {
    const r = resolveSel();
    if (!r) return;
    if (r.kind === "object") {
      const clone = { ...r.obj, id: uid("o"), name: r.obj.name, x: r.obj.x + 20, y: r.obj.y + 20 };
      r.room.objects.push(clone);
      save();
      select({ kind: "object", roomId: r.room.id, objId: clone.id });
    } else {
      const clone = {
        ...r.room,
        id: uid("r"),
        name: r.room.name + " copy",
        x: r.room.x + 30,
        y: r.room.y + 30,
        notches: (r.room.notches || []).map(cloneNotch),
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
    const [mx, my] = [wrap.clientWidth / 2, wrap.clientHeight / 2];
    const [wx, wy] = screenToWorld(mx, my);
    view.scale = clamp(view.scale * factor, 0.05, 6);
    view.ox = mx - wx * view.scale;
    view.oy = my - wy * view.scale;
    render();
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
    // Missing rev/updatedAt stay 0 so an untouched copy can't outrank real data.
    return { version: SCHEMA_VERSION, rev: +data.rev || 0, updatedAt: +data.updatedAt || 0, activeId, layouts };
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
    renderLayoutBar();
    render();
    refreshPanel();
  }

  function activeLayout() {
    return doc.layouts.find((l) => l.id === doc.activeId) || doc.layouts[0];
  }

  let saveTimer = null;
  let suppressSync = false; // true while applying a remote doc, to avoid loops
  function save() {
    if (!suppressSync) {
      // Bump the monotonic revision (skew-proof ordering) and a display time.
      doc.rev = DRIVE.nextRev();
      doc.updatedAt = Date.now();
    }
    try {
      localStorage.setItem(STORAGE_KEY, serialize());
    } catch (_) {}
    if (!suppressSync) DRIVE.scheduleSync();
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
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
    const LS = {
      clientId: "floorplan.drive.clientId",
      fileId: "floorplan.drive.fileId",
      connected: "floorplan.drive.connected",
      auto: "floorplan.drive.auto",
      lastRev: "floorplan.drive.lastRev",
    };

    let clientId = localStorage.getItem(LS.clientId) || DEFAULT_CLIENT_ID;
    let fileId = localStorage.getItem(LS.fileId) || "";
    let connected = localStorage.getItem(LS.connected) === "1";
    let auto = localStorage.getItem(LS.auto) !== "0";
    let lastSeenRev = +localStorage.getItem(LS.lastRev) || 0;
    let token = null;
    let tokenExp = 0;
    let tokenClient = null;
    let busy = false;
    let timer = null;

    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
    function setLastSeenRev(r) { lastSeenRev = Math.max(lastSeenRev, +r || 0); lsSet(LS.lastRev, String(lastSeenRev)); }
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
      b.title = connected ? "Google Drive: connected" : "Google Drive: not connected";
    }
    function updateUI() {
      el("drive-auto").checked = auto;
      el("drive-connect").hidden = connected;
      el("drive-disconnect").hidden = !connected;
      el("drive-syncnow").hidden = !connected;
      el("drive-force-row").hidden = !connected;
      pill();
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
        token = null;
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
      busy = true;
      setStatus("Syncing…");
      try {
        await getToken(interactive);
        const files = await listFiles();

        // No file yet -> create one from the local plan.
        if (files.length === 0) {
          fileId = await createFile(serialize());
          lsSet(LS.fileId, fileId);
          setLastSeenRev(+doc.rev || 0);
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
          await updateFile(canonical, serialize());
          setLastSeenRev(+doc.rev || 0);
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

    function timeNow() {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    function scheduleSync() {
      if (!connected || !auto) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncNow(false, "auto"), 2500);
    }

    async function connect() {
      if (!clientId) { setStatus("No OAuth Client ID configured.", "err"); return; }
      if (!gisReady()) { setStatus("Google library not loaded — check your connection.", "err"); return; }
      try {
        setStatus("Connecting…");
        await getToken(true);
        connected = true;
        lsSet(LS.connected, "1");
        updateUI();
        await syncNow(true, "firstConnect");
      } catch (e) {
        setStatus("Could not connect: " + e.message, "err");
      }
    }

    function disconnect() {
      try {
        if (token && gisReady() && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(token, () => {});
      } catch (_) {}
      token = null;
      connected = false;
      lsSet(LS.connected, "0");
      updateUI();
      setStatus("Disconnected.");
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
      // If previously connected with auto-sync on, silently pull the latest once
      // the library loads. With auto-sync off we leave it to manual Sync/Force.
      if (connected && clientId && auto) {
        waitForGis((ok) => {
          if (!ok) { setStatus("Google library unavailable (offline?).", "err"); return; }
          getToken(false).then(() => syncNow(false, "auto")).catch(() => setStatus("Sign-in expired — open Drive and reconnect.", "err"));
        });
      }
    }

    return { scheduleSync, boot, nextRev };
  })();

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    const typing = e.target.matches("input, select, textarea");
    if (typing) return;
    const r = resolveSel();
    if ((e.key === "Delete" || e.key === "Backspace") && r) { e.preventDefault(); deleteSel(); }
    else if (e.key.toLowerCase() === "r" && r && r.kind === "object") { rotateSel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && r) { e.preventDefault(); duplicateSel(); }
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
  el("btn-add-room").addEventListener("click", addRoom);
  el("btn-add-object").addEventListener("click", addObject);
  el("btn-rotate").addEventListener("click", rotateSel);
  el("btn-duplicate").addEventListener("click", duplicateSel);
  el("btn-delete").addEventListener("click", deleteSel);
  el("btn-deselect").addEventListener("click", () => select(null));
  el("btn-zoom-in").addEventListener("click", () => zoomBy(1.2));
  el("btn-zoom-out").addEventListener("click", () => zoomBy(1 / 1.2));
  el("btn-zoom-reset").addEventListener("click", fitView);
  el("chk-edges").addEventListener("change", (e) => { ui.edges = e.target.checked; render(); });
  el("chk-grid").addEventListener("change", (e) => { ui.grid = e.target.checked; render(); });
  el("chk-snap").addEventListener("change", (e) => { ui.snap = e.target.checked; });
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

  // Layout controls
  el("layout-select").addEventListener("change", (e) => setActiveLayout(e.target.value));
  el("btn-layout-dup").addEventListener("click", duplicateLayout);
  el("btn-layout-new").addEventListener("click", newLayout);
  el("btn-layout-rename").addEventListener("click", renameLayout);
  el("btn-layout-delete").addEventListener("click", deleteLayout);

  window.addEventListener("resize", render);
  // Flush any debounced save if the tab is being hidden or closed.
  window.addEventListener("beforeunload", save);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  doc = load() || sample();
  state = activeLayout();
  bindPanel();
  renderLayoutBar();
  refreshPanel();
  fitView();
  DRIVE.boot();
})();
