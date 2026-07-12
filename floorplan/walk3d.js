// First-person "walk around the plan" 3D mode. Reads the plan as plain box data
// from app.js (window.__plan3d.build) and renders it with three.js (loaded on
// demand). Kept fully separate from the 2D app; if three.js can't load the 2D
// app is unaffected.
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

  let THREE = null, renderer = null, scene = null, camera = null;
  let raf = 0, active = false, last = 0;
  let colliders = [], grounds = [];
  let yaw = 0, pitch = 0, flyOffset = 0, groundY = 0;
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

  // Walkable surface under (x,z): the highest floor / stair top you can reach —
  // i.e. no more than STEP_UP above your feet (so you climb stairs one step at a
  // time, and stay on the floor under the stairs instead of being lifted onto
  // them). You can always drop to a lower surface (the floor is at 0).
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

  function build() {
    const data = window.__plan3d.build();
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1220");
    scene.fog = new THREE.Fog("#0b1220", 800, 6000);
    scene.add(new THREE.HemisphereLight("#ffffff", "#1e293b", 1.15));
    const dl = new THREE.DirectionalLight("#ffffff", 0.55);
    dl.position.set(0.4, 1, 0.6);
    scene.add(dl);

    const W = holder.clientWidth || window.innerWidth, H = holder.clientHeight || window.innerHeight;
    camera = new THREE.PerspectiveCamera(72, W / H, 4, 30000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    holder.appendChild(renderer.domElement);
    renderer.domElement.addEventListener("click", () => renderer.domElement.requestPointerLock());

    colliders = []; grounds = [];
    const cache = {};
    const matFor = (c, kind) => {
      const key = c + kind;
      if (!cache[key]) cache[key] = new THREE.MeshLambertMaterial({ color: c, transparent: kind === "ceiling", opacity: kind === "ceiling" ? 0.5 : 1 });
      return cache[key];
    };
    for (const b of data.boxes) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), matFor(b.color, b.kind));
      mesh.position.set(b.cx, b.z + b.h / 2, b.cy);
      if (b.rot) mesh.rotation.y = (-b.rot * Math.PI) / 180;
      scene.add(mesh);
      if (b.kind === "wall" && b.z < 150 && b.z + b.h > 40) colliders.push(b);
      if (b.kind === "floor" || b.kind === "stair") grounds.push(b);
    }

    groundY = groundAt(data.spawn.x, data.spawn.y, 0);
    camera.position.set(data.spawn.x, groundY + EYE, data.spawn.y);
    yaw = 0; pitch = 0; flyOffset = 0;
    onResize();
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
  function onMouse(e) {
    if (!active || document.pointerLockElement !== renderer.domElement) return;
    yaw -= e.movementX * 0.0022;
    pitch -= e.movementY * 0.0022;
    const lim = Math.PI / 2 - 0.05;
    pitch = Math.max(-lim, Math.min(lim, pitch));
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
    statusEl.textContent = "Click the view to look around";
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", keyDown, { passive: false });
    window.addEventListener("keyup", keyUp);
    window.addEventListener("mousemove", onMouse);
    raf = requestAnimationFrame(frame);
  }

  function close() {
    active = false;
    cancelAnimationFrame(raf);
    if (document.pointerLockElement) document.exitPointerLock();
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    window.removeEventListener("mousemove", onMouse);
    for (const k in keys) delete keys[k];
    overlay.hidden = true;
    if (renderer) { renderer.dispose(); }
    holder.innerHTML = "";
    renderer = null; scene = null; camera = null;
  }

  const keyDown = onKey(true), keyUp = onKey(false);
  btn.addEventListener("click", open);
  exitBtn.addEventListener("click", close);
  window.addEventListener("keydown", (e) => { if (active && e.code === "Escape" && !document.pointerLockElement) close(); });
})();
