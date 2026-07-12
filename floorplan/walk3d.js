// First-person "walk around the plan" 3D mode. Reads the plan as plain box data
// from app.js (window.__plan3d.build) and renders it with three.js (loaded on
// demand). Kept fully separate from the 2D app; if three.js can't load the 2D
// app is unaffected. Controls work on both desktop (drag + WASD) and touch
// (drag to look + an on-screen movement pad) — iOS has no pointer lock.
(function () {
  "use strict";
  const btn = document.getElementById("btn-walk3d");
  const overlay = document.getElementById("walk3d");
  const holder = document.getElementById("walk3d-canvas");
  const statusEl = document.getElementById("walk3d-status");
  const exitBtn = document.getElementById("walk3d-exit");
  if (!btn || !overlay || !holder) return;

  const EYE = 160;      // eye height above the floor (cm)
  const RADIUS = 18;    // body radius for wall collision (cm)
  const SPEED = 320;    // walk speed (cm/s)
  const FLY = 260;      // vertical fly speed (cm/s)
  const STEP_UP = 40;   // most you can step up in one go (climb stairs; stay under them)
  const PITCH_LIM = Math.PI / 2 - 0.05;

  const roomHud = document.getElementById("walk3d-room");

  let THREE = null, renderer = null, scene = null, camera = null;
  let raf = 0, active = false, last = 0;
  let colliders = [], grounds = [], roomsList = [];
  let yaw = 0, pitch = 0, flyOffset = 0, groundY = 0, curRoom = null;
  const keys = Object.create(null);

  function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    // three.js ships only an ES module build now (the UMD global was removed in
    // r150), so load it with a dynamic import from a CDN.
    return import("https://unpkg.com/three@0.160.0/build/three.module.js")
      .then((mod) => (window.THREE = mod, mod))
      .catch(() => { throw new Error("Couldn't load the 3D library — check your connection (needs the hosted site)."); });
  }

  // Is plan point (x,z) inside box b's footprint (honouring its rotation)?
  function inFootprint(b, x, z) {
    let dx = x - b.cx, dz = z - b.cy;
    if (b.rot) {
      const a = (b.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const rx = dx * c + dz * s, rz = -dx * s + dz * c;
      dx = rx; dz = rz;
    }
    return Math.abs(dx) <= b.w / 2 && Math.abs(dz) <= b.d / 2;
  }

  // Walkable surface under (x,z): the highest floor / stair top no more than
  // STEP_UP above your feet (climb stairs a step at a time; stay on the floor
  // under them). You can always drop to a lower surface (the floor is at 0).
  function groundAt(x, z, feetY) {
    let g = 0;
    for (const b of grounds) {
      if (!inFootprint(b, x, z)) continue;
      const top = b.z + b.h;
      if (top <= feetY + STEP_UP && top > g) g = top;
    }
    return g;
  }

  // Resolve the camera circle out of any wall box it overlaps (axis-aligned).
  function collide(x, z) {
    for (let iter = 0; iter < 3; iter++) {
      let hit = false;
      for (const b of colliders) {
        const hw = b.w / 2 + RADIUS, hd = b.d / 2 + RADIUS;
        const dx = x - b.cx, dz = z - b.cy;
        if (Math.abs(dx) < hw && Math.abs(dz) < hd) {
          hit = true;
          const px = hw - Math.abs(dx), pz = hd - Math.abs(dz);
          if (px < pz) x = b.cx + (dx < 0 ? -hw : hw);
          else z = b.cy + (dz < 0 ? -hd : hd);
        }
      }
      if (!hit) break;
    }
    return [x, z];
  }

  let edgeMat = null;
  function addEdges(geo, position, rotationY) {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    if (position) e.position.copy(position);
    if (rotationY) e.rotation.y = rotationY;
    scene.add(e);
  }

  function build() {
    const data = window.__plan3d.build();
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#dbe4f0");
    scene.add(new THREE.HemisphereLight("#ffffff", "#8794a8", 1.0));
    const dl = new THREE.DirectionalLight("#ffffff", 0.85); dl.position.set(0.5, 1, 0.25); scene.add(dl);
    const dl2 = new THREE.DirectionalLight("#c7d2fe", 0.45); dl2.position.set(-0.4, 0.5, -0.6); scene.add(dl2);
    edgeMat = new THREE.LineBasicMaterial({ color: "#1e293b", transparent: true, opacity: 0.55 });

    const W = holder.clientWidth || window.innerWidth, H = holder.clientHeight || window.innerHeight;
    camera = new THREE.PerspectiveCamera(75, W / H, 4, 30000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    holder.appendChild(renderer.domElement);
    attachLook(renderer.domElement);
    makeControls();

    colliders = []; grounds = []; roomsList = data.rooms || []; curRoom = null;
    const cache = {};
    const trans = (k) => k === "ceiling" || k === "glass";
    const matFor = (c, kind) => {
      const key = c + kind;
      if (!cache[key]) cache[key] = new THREE.MeshLambertMaterial({ color: c, transparent: trans(kind), opacity: kind === "ceiling" ? 0.35 : kind === "glass" ? 0.3 : 1, side: trans(kind) ? THREE.DoubleSide : THREE.FrontSide });
      return cache[key];
    };
    for (const b of data.boxes) {
      if (b.kind !== "collider") { // "collider" boxes block but aren't drawn
        const geo = new THREE.BoxGeometry(b.w, b.h, b.d);
        const mesh = new THREE.Mesh(geo, matFor(b.color, b.kind));
        mesh.position.set(b.cx, b.z + b.h / 2, b.cy);
        const ry = b.rot ? (-b.rot * Math.PI) / 180 : 0;
        if (ry) mesh.rotation.y = ry;
        scene.add(mesh);
        if (b.kind !== "ceiling" && b.kind !== "glass") addEdges(geo, mesh.position, ry);
      }
      if ((b.kind === "wall" || b.kind === "collider") && b.z < 150 && b.z + b.h > 40) colliders.push(b);
      if (b.kind === "floor" || b.kind === "stair") grounds.push(b);
    }
    for (const s of data.stairs || []) buildStair(s);

    groundY = groundAt(data.spawn.x, data.spawn.y, 0);
    camera.position.set(data.spawn.x, groundY + EYE, data.spawn.y);
    yaw = 0; pitch = -0.12; flyOffset = 0; // start looking very slightly down into the room
    onResize();
  }

  // Custom stair mesh: a diagonal soffit (the understair-cupboard roof, with the
  // flat treads sitting on it) plus solid triangular side walls, each with a door
  // hole on a door side — flat-topped, or diagonally cut where it meets the soffit.
  function buildStair(s) {
    const V = (px, py, h) => new THREE.Vector3(px, h, py); // plan (px,py) + height -> three
    const z0 = s.zBase, z1 = s.zBase + s.rise;
    const bl = V(s.bl[0], s.bl[1], z0), br = V(s.br[0], s.br[1], z0);
    const tr = V(s.tr[0], s.tr[1], z1), tl = V(s.tl[0], s.tl[1], z1);
    const pos = [];
    const tri = (a, b, c) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    tri(bl, br, tr); tri(bl, tr, tl); // diagonal soffit quad
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: s.color, side: THREE.DoubleSide })));
    buildStairSide(s, s.bl, s.tl, s.doors.left);
    buildStairSide(s, s.br, s.tr, s.doors.right);
  }

  function buildStairSide(s, low, high, hasDoor) {
    const runLen = Math.hypot(high[0] - low[0], high[1] - low[1]) || 1;
    const rise = s.rise;
    const soffitH = (a) => (rise * a) / runLen; // roof height along the run
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(runLen, 0); shape.lineTo(runLen, rise); shape.lineTo(0, 0);
    if (hasDoor) {
      const dw = s.doorWidth, dL = runLen / 2 - dw / 2, dR = runLen / 2 + dw / 2;
      const topAt = (a) => Math.max(5, Math.min(s.doorHeight, soffitH(a) - 2)); // stay under the soffit
      const hole = new THREE.Path();
      hole.moveTo(dL, 0); hole.lineTo(dR, 0);
      for (let k = 0; k <= 6; k++) { const a = dR - (dR - dL) * (k / 6); hole.lineTo(a, topAt(a)); }
      shape.holes.push(hole);
    }
    const geo = new THREE.ShapeGeometry(shape);
    const p = geo.attributes.position;
    const runDir = [(high[0] - low[0]) / runLen, (high[1] - low[1]) / runLen];
    for (let i = 0; i < p.count; i++) {
      const a = p.getX(i), z = p.getY(i);
      p.setXYZ(i, low[0] + runDir[0] * a, s.zBase + z, low[1] + runDir[1] * a);
    }
    p.needsUpdate = true;
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: s.color, side: THREE.DoubleSide })));
    scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat)); // outline the door shape
  }

  // ----- Look (drag) — works for both touch and mouse; no pointer lock -----
  function attachLook(el) {
    let drag = null;
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, id: e.pointerId }; try { el.setPointerCapture(e.pointerId); } catch (_) {} });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      yaw -= (e.clientX - drag.x) * 0.004;
      pitch -= (e.clientY - drag.y) * 0.004;
      pitch = Math.max(-PITCH_LIM, Math.min(PITCH_LIM, pitch));
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  // ----- On-screen movement pad (touch) -----
  function makeControls() {
    const mk = (label, code, cls) => {
      const b = document.createElement("button");
      b.className = "walk3d-key " + (cls || "");
      b.textContent = label;
      const set = (v) => (e) => { e.preventDefault(); e.stopPropagation(); keys[code] = v; };
      b.addEventListener("pointerdown", set(true));
      b.addEventListener("pointerup", set(false));
      b.addEventListener("pointerleave", set(false));
      b.addEventListener("pointercancel", set(false));
      return b;
    };
    const pad = document.createElement("div");
    pad.className = "walk3d-pad";
    pad.append(
      mk("▲", "keyw", "up"), mk("◀", "keya", "left"),
      mk("▶", "keyd", "right"), mk("▼", "keys", "down")
    );
    holder.appendChild(pad);
    const vpad = document.createElement("div");
    vpad.className = "walk3d-vpad";
    vpad.append(mk("⤒", "space"), mk("⤓", "shiftleft"));
    holder.appendChild(vpad);
  }

  function onResize() {
    if (!renderer || !camera) return;
    const W = holder.clientWidth || window.innerWidth, H = holder.clientHeight || window.innerHeight;
    renderer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }

  function frame(t) {
    if (!active) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (t - last) / 1000 : 0);
    last = t;

    camera.rotation.set(pitch, yaw, 0, "YXZ");
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let fx = 0, fz = 0;
    if (keys["keyw"] || keys["arrowup"]) { fx -= sy; fz -= cy; }
    if (keys["keys"] || keys["arrowdown"]) { fx += sy; fz += cy; }
    if (keys["keya"] || keys["arrowleft"]) { fx -= cy; fz += sy; }
    if (keys["keyd"] || keys["arrowright"]) { fx += cy; fz -= sy; }
    const len = Math.hypot(fx, fz);
    let x = camera.position.x, z = camera.position.z;
    if (len > 0.01) {
      x += (fx / len) * SPEED * dt;
      z += (fz / len) * SPEED * dt;
      [x, z] = collide(x, z);
    }
    if (keys["space"]) flyOffset += FLY * dt;
    if (keys["shiftleft"] || keys["shiftright"]) flyOffset -= FLY * dt;
    flyOffset = Math.max(-EYE + 20, Math.min(flyOffset, 4000));

    camera.position.x = x;
    camera.position.z = z;
    groundY = groundAt(x, z, groundY); // step-up / drop follow (climb or go under stairs)
    camera.position.y = groundY + EYE + flyOffset;

    if (roomHud) {
      let name = "";
      const y = camera.position.y;
      for (const r of roomsList) {
        if (x >= r.minx && x <= r.maxx && z >= r.miny && z <= r.maxy && y >= r.z0 - 40 && y <= r.z1 + 120) { name = r.name; break; }
      }
      if (name !== curRoom) { curRoom = name; roomHud.textContent = name; roomHud.style.display = name ? "block" : "none"; }
    }
    renderer.render(scene, camera);
  }

  function onKey(down) {
    return (e) => {
      if (!active) return;
      const c = e.code.toLowerCase();
      if (["keyw", "keya", "keys", "keyd", "space", "arrowup", "arrowdown", "arrowleft", "arrowright", "shiftleft", "shiftright"].includes(c)) e.preventDefault();
      keys[c] = down;
    };
  }

  async function open() {
    overlay.hidden = false;
    statusEl.textContent = "Loading 3D…";
    try {
      THREE = await loadThree();
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    if (!window.__plan3d) { statusEl.textContent = "3D unavailable."; return; }
    build();
    active = true;
    last = 0;
    statusEl.textContent = "Drag to look";
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", keyDown, { passive: false });
    window.addEventListener("keyup", keyUp);
    raf = requestAnimationFrame(frame);
  }

  function close() {
    active = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    for (const k in keys) delete keys[k];
    if (roomHud) roomHud.style.display = "none";
    overlay.hidden = true;
    if (renderer) { renderer.dispose(); }
    holder.innerHTML = "";
    renderer = null; scene = null; camera = null;
  }

  const keyDown = onKey(true), keyUp = onKey(false);
  btn.addEventListener("click", open);
  exitBtn.addEventListener("click", close);
  window.addEventListener("keydown", (e) => { if (active && e.code === "Escape") close(); });
})();
