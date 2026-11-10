import * as THREE from "three";

// The hero scene shows what fusebox does, on a sample repo (this one):
//   SCAN    every file is hashed into a local index; the dependency graph lights up
//   QUERY   an agent asks a question; the answer is a file:line reference, not a summary
//   CONFLICT an export signature changes; its importers are flagged with references
//   VERIFY  hashes are re-checked against disk and the graph settles
// Names and line numbers are real files from this repository; hashes are samples.

type Stage = "scan" | "query" | "conflict" | "verify";

interface GraphNode {
  path: string;
  pos: [number, number, number];
}

// Index = node id. Keep in sync with EDGES below.
const NODES: GraphNode[] = [
  { path: "cli/runCli.ts", pos: [-2.2, 1.5, 0.6] }, // 0
  { path: "mcp/server.ts", pos: [2.0, 1.7, 0.4] }, // 1
  { path: "mcp/tools.ts", pos: [1.1, 1.2, -0.7] }, // 2
  { path: "engine/indexEngine.ts", pos: [0.9, 0.1, 1.0] }, // 3
  { path: "engine/tsIndexEngine.ts", pos: [0.0, -0.1, 0.0] }, // 4
  { path: "engine/indexSchema.ts", pos: [-1.0, -0.6, 0.8] }, // 5
  { path: "engine/indexConflicts.ts", pos: [-0.5, -1.0, -0.4] }, // 6
  { path: "engine/cache.ts", pos: [1.7, -0.3, -0.6] }, // 7
  { path: "engine/git.ts", pos: [2.3, 0.5, -0.2] }, // 8
  { path: "parsers/index.ts", pos: [1.2, -1.2, 0.4] }, // 9
  { path: "parsers/jsTs.ts", pos: [2.2, -1.6, -0.6] }, // 10
  { path: "parsers/types.ts", pos: [1.0, -1.9, -0.9] }, // 11
  { path: "security/walker.ts", pos: [-1.8, -1.4, 0.2] }, // 12
  { path: "security/safeRead.ts", pos: [-2.4, -0.8, -0.5] }, // 13
  { path: "engine/contextQuery.ts", pos: [-0.2, 0.9, 0.9] }, // 14
  { path: "engine/cards.ts", pos: [-1.3, 0.6, -0.3] }, // 15
  { path: "engine/tickets.ts", pos: [-2.3, 0.3, -0.6] }, // 16
  { path: "cli/review.ts", pos: [-1.2, 1.9, -0.8] }, // 17
];

// [importer, imported]
const EDGES: [number, number][] = [
  [0, 4], [0, 14], [0, 16], [0, 17],
  [1, 2], [2, 14], [2, 16], [2, 15],
  [14, 15], [14, 4],
  [4, 3], [4, 5], [4, 6], [4, 7], [4, 8], [4, 9], [4, 12], [4, 13],
  [6, 5], [9, 10], [9, 11], [10, 11], [12, 13], [17, 16], [17, 15],
];

const QUERY_PATH = [1, 2, 14, 4, 6]; // mcp server -> tools -> context -> engine -> conflicts
const QUERY_TARGETS = [6, 4];
const CHANGED = 11;
const DIRECT_CALLERS = [9, 10];
const TRANSITIVE = [4];

const T_SCAN = 0;
const T_QUERY = 3.4;
const T_CONFLICT = 7.6;
const T_VERIFY = 11.8;
const T_END = 15;
const STATIC_TIME = 6.6; // reduced motion: query answered, labels visible

const CAPTIONS: Record<Stage, [string, string]> = {
  scan: ["SCANNING", "Hashing every file into a local index."],
  query: ["QUERYING", "The agent asks. The answer is a file:line reference."],
  conflict: ["CONFLICT", "A signature changed. Importers are flagged with references."],
  verify: ["VERIFIED", "Hashes re-checked against disk. Nothing unverified."],
};

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const smooth = (value: number): number => {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
};
const stageAt = (t: number): Stage =>
  t < T_QUERY ? "scan" : t < T_CONFLICT ? "query" : t < T_VERIFY ? "conflict" : "verify";

interface Tag {
  el: HTMLElement;
  node: number;
}

export function initHeroScene(canvas: HTMLCanvasElement): void {
  const parent = canvas.parentElement;
  if (!parent) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
  const graph = new THREE.Group();
  scene.add(graph);

  const dim = new THREE.Color(0x3a4134);
  const green = new THREE.Color(0xb7f36b);
  const bone = new THREE.Color(0xeee9dc);
  const orange = new THREE.Color(0xff7043);
  const amber = new THREE.Color(0xc9893a);
  const edgeBase = new THREE.Color(0x2a3025);

  const positions = NODES.map((node) => new THREE.Vector3(...node.pos));

  // File nodes.
  const nodeMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    NODES.length,
  );
  nodeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  nodeMesh.frustumCulled = false;
  graph.add(nodeMesh);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();

  // Import edges, colored per vertex so a path can light up.
  const edgePositions: number[] = [];
  for (const [from, to] of EDGES) {
    const a = positions[from];
    const b = positions[to];
    if (!a || !b) continue;
    edgePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePositions, 3));
  const edgeColors = new Float32Array(EDGES.length * 6);
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  graph.add(new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ vertexColors: true })));

  // Scan plane sweeping across x.
  const scanMaterial = new THREE.MeshBasicMaterial({
    color: green,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const scanPlane = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 4.6), scanMaterial);
  scanPlane.rotation.y = Math.PI / 2;
  graph.add(scanPlane);

  // Lock brackets around the nodes a query lands on, and the node that changes.
  const bracketGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.42, 0.42, 0.42));
  const brackets = [...QUERY_TARGETS, CHANGED].map((nodeId) => {
    const material = new THREE.LineBasicMaterial({ color: green, transparent: true, opacity: 0 });
    const mesh = new THREE.LineSegments(bracketGeometry, material);
    mesh.position.copy(positions[nodeId] ?? new THREE.Vector3());
    graph.add(mesh);
    return { nodeId, mesh, material };
  });

  // Travelling pulses: [0] query, [1..2] edit propagation.
  const pulseGeometry = new THREE.SphereGeometry(0.06, 10, 8);
  const pulses = [green, orange, orange].map((tint) => {
    const mesh = new THREE.Mesh(pulseGeometry, new THREE.MeshBasicMaterial({ color: tint, transparent: true }));
    mesh.visible = false;
    graph.add(mesh);
    return mesh;
  });

  // DOM callouts.
  const tagFor = (nodeId: number, className: string): Tag => {
    const el = document.createElement("div");
    el.className = `node-tag ${className}`;
    parent.appendChild(el);
    return { el, node: nodeId };
  };
  const tagQueryA = tagFor(6, "is-query");
  const tagQueryB = tagFor(4, "is-query");
  const tagChange = tagFor(CHANGED, "is-change");
  tagQueryA.el.innerHTML = `<b>[engine/indexConflicts.ts:219]</b><span>compareAndSwapSymbol · sha 9f3a1c</span>`;
  tagChange.el.innerHTML =
    `<b>BREAKING · parsers/types.ts:60</b>` +
    `<span>ParsedFile changed · sha 9f3a1c → 77be02</span>` +
    `<span>callers: parsers/index.ts, parsers/jsTs.ts</span>`;
  tagQueryB.el.innerHTML = `<b>[engine/tsIndexEngine.ts:336]</b><span>index() · sha 4be07d</span>`;
  const tags = [tagQueryA, tagQueryB, tagChange];

  const stateEl = document.querySelector<HTMLElement>(".core-state");
  const captionEl = document.querySelector<HTMLElement>(".core-caption");
  const stageEls = [...document.querySelectorAll<HTMLElement>(".core-stages [data-stage]")];
  let lastStage: Stage | null = null;
  const setStage = (stage: Stage): void => {
    if (stage === lastStage) return;
    lastStage = stage;
    const [state, caption] = CAPTIONS[stage];
    if (stateEl) stateEl.textContent = state;
    if (captionEl) captionEl.textContent = caption;
    for (const el of stageEls) el.classList.toggle("is-active", el.dataset["stage"] === stage);
  };

  const pointer = new THREE.Vector2();
  const pointerTarget = new THREE.Vector2();
  const hero = canvas.closest<HTMLElement>(".hero") ?? parent;
  let scroll = 0;
  let scrollTarget = 0;
  let viewportScale = 1;
  let frame = 0;
  let inView = true;
  let disposed = false;
  let startTime = performance.now();
  const projected = new THREE.Vector3();

  const updateScroll = (): void => {
    const rect = hero.getBoundingClientRect();
    scrollTarget = clamp(-rect.top / Math.max(hero.offsetHeight * 0.8, 1));
  };

  const setNodeColor = (index: number, target: THREE.Color, scale: number): void => {
    const position = positions[index];
    if (!position) return;
    dummy.position.copy(position);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    nodeMesh.setMatrixAt(index, dummy.matrix);
    nodeMesh.setColorAt(index, target);
  };

  const placeOnPath = (path: number[], progress: number, mesh: THREE.Mesh): void => {
    const segments = path.length - 1;
    const scaled = clamp(progress) * segments;
    const index = Math.min(Math.floor(scaled), segments - 1);
    const a = positions[path[index] ?? 0];
    const b = positions[path[index + 1] ?? 0];
    if (!a || !b) return;
    mesh.position.lerpVectors(a, b, scaled - index);
  };

  const renderFrame = (time: number): void => {
    const t = reduce ? STATIC_TIME : time % T_END;
    const stage = stageAt(t);
    setStage(stage);
    const fade = 1 - smooth((t - (T_END - 0.9)) / 0.9); // soft reset before the loop restarts

    pointer.lerp(pointerTarget, 0.055);
    scroll += (scrollTarget - scroll) * 0.065;
    graph.rotation.set(
      -0.1 + pointer.y * 0.1 + Math.sin(time * 0.24) * 0.02,
      -0.42 + pointer.x * 0.2 + Math.sin(time * 0.15) * 0.14,
      0,
    );
    graph.position.y = scroll * 0.6;
    graph.position.z = -scroll;
    graph.scale.setScalar(viewportScale * (1 - scroll * 0.12));

    // SCAN: a plane sweeps left to right; nodes ahead of it are unindexed.
    const sweepProgress = reduce ? 1 : clamp((t - T_SCAN - 0.2) / (T_QUERY - 0.8));
    const sweepX = -2.9 + sweepProgress * 5.8;
    scanPlane.position.x = sweepX;
    scanMaterial.opacity = reduce ? 0 : 0.07 * Math.sin(Math.PI * sweepProgress) * fade;

    // Per-node and per-edge state for this instant.
    const nodeLevel = new Array<number>(NODES.length).fill(0); // 0 dim .. 1 indexed
    const nodeHeat = new Array<number>(NODES.length).fill(0); // 1 conflict orange
    const nodeLock = new Array<number>(NODES.length).fill(0); // 1 query result
    const edgeGreen = new Array<number>(EDGES.length).fill(0);
    const edgeOrange = new Array<number>(EDGES.length).fill(0);
    const edgeIndex = (a: number, b: number): number =>
      EDGES.findIndex(([from, to]) => (from === a && to === b) || (from === b && to === a));

    for (let i = 0; i < NODES.length; i += 1) {
      const x = positions[i]?.x ?? 0;
      nodeLevel[i] = smooth((sweepX - x) / 0.5) * fade;
    }
    const edgeLevel = EDGES.map(([from, to]) => Math.min(nodeLevel[from] ?? 0, nodeLevel[to] ?? 0));

    // QUERY: pulse walks the path; edges stay lit behind it; targets lock on arrival.
    const queryProgress = clamp((t - T_QUERY - 0.3) / 2.4);
    const pathSegments = QUERY_PATH.length - 1;
    if (t >= T_QUERY && t < T_END) {
      for (let s = 0; s < pathSegments; s += 1) {
        const e = edgeIndex(QUERY_PATH[s] ?? 0, QUERY_PATH[s + 1] ?? 0);
        if (e >= 0) edgeGreen[e] = clamp(queryProgress * pathSegments - s) * fade;
      }
      for (let s = 0; s < QUERY_PATH.length; s += 1) {
        const arrival = clamp((queryProgress * pathSegments - (s - 0.1)) / 0.5);
        const id = QUERY_PATH[s] ?? 0;
        nodeLock[id] = Math.max(nodeLock[id] ?? 0, arrival * (QUERY_TARGETS.includes(id) ? 1 : 0.5) * fade);
      }
    }
    const pulseQuery = pulses[0];
    if (pulseQuery) {
      pulseQuery.visible = !reduce && queryProgress > 0 && queryProgress < 1 && t < T_CONFLICT;
      if (pulseQuery.visible) placeOnPath(QUERY_PATH, queryProgress, pulseQuery);
    }

    // CONFLICT: the changed node goes orange, then direct callers, then transitive ones.
    const conflictT = t - T_CONFLICT;
    const verifyT = t - T_VERIFY;
    const healing = t >= T_VERIFY ? smooth(verifyT / 1.6) : 0;
    const heatOut = (1 - healing) * fade;
    if (t >= T_CONFLICT) {
      nodeHeat[CHANGED] = smooth(conflictT / 0.4) * heatOut;
      const direct = smooth((conflictT - 0.9) / 0.4) * heatOut;
      const transitive = smooth((conflictT - 1.9) / 0.4) * heatOut;
      for (const id of DIRECT_CALLERS) nodeHeat[id] = direct;
      for (const id of TRANSITIVE) nodeHeat[id] = Math.max(nodeHeat[id] ?? 0, transitive * 0.7);
      for (const id of DIRECT_CALLERS) {
        const e = edgeIndex(id, CHANGED);
        if (e >= 0) edgeOrange[e] = smooth((conflictT - 0.4) / 0.6) * heatOut;
      }
      for (const id of TRANSITIVE) {
        const e = edgeIndex(id, 9);
        if (e >= 0) edgeOrange[e] = smooth((conflictT - 1.4) / 0.6) * heatOut * 0.7;
      }
    }
    const callerPulses = [pulses[1], pulses[2]];
    callerPulses.forEach((mesh, i) => {
      if (!mesh) return;
      const p = (conflictT - 0.4) / 0.6;
      mesh.visible = !reduce && t >= T_CONFLICT && p > 0 && p < 1 && t < T_VERIFY;
      if (mesh.visible) {
        const caller = DIRECT_CALLERS[i] ?? 9;
        mesh.position.lerpVectors(positions[CHANGED] ?? new THREE.Vector3(), positions[caller] ?? new THREE.Vector3(), p);
      }
    });

    // Write node transforms and colors.
    for (let i = 0; i < NODES.length; i += 1) {
      color.copy(dim).lerp(green, (nodeLevel[i] ?? 0) * 0.55);
      color.lerp(bone, (nodeLock[i] ?? 0) * 0.85);
      const heat = nodeHeat[i] ?? 0;
      const heatColor = TRANSITIVE.includes(i) && !DIRECT_CALLERS.includes(i) ? amber : orange;
      color.lerp(heatColor, heat);
      const flash = reduce || sweepProgress >= 1 ? 0 : Math.pow(Math.max(0, 1 - Math.abs(sweepX - (positions[i]?.x ?? 0)) * 2.4), 2);
      color.lerp(green, flash * 0.6);
      const scale = 1 + (nodeLock[i] ?? 0) * 0.45 + heat * 0.35 + flash * 0.4;
      setNodeColor(i, color, scale);
    }
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;

    for (let e = 0; e < EDGES.length; e += 1) {
      color.copy(edgeBase).lerp(green, (edgeLevel[e] ?? 0) * 0.4);
      color.lerp(green, edgeGreen[e] ?? 0);
      color.lerp(orange, edgeOrange[e] ?? 0);
      edgeColors.set([color.r, color.g, color.b, color.r, color.g, color.b], e * 6);
    }
    (edgeGeometry.getAttribute("color") as THREE.BufferAttribute).needsUpdate = true;

    // Brackets.
    for (const { nodeId, material, mesh } of brackets) {
      const locked = nodeId === CHANGED ? nodeHeat[CHANGED] ?? 0 : nodeLock[nodeId] ?? 0;
      material.opacity = locked * 0.9;
      material.color.copy(nodeId === CHANGED ? orange : green);
      mesh.scale.setScalar(1.4 - locked * 0.4);
      mesh.rotation.y = (1 - locked) * 0.8;
    }

    renderer.render(scene, camera);

    // Callouts follow their nodes.
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    graph.updateWorldMatrix(true, false);
    for (const tag of tags) {
      const isChange = tag.node === CHANGED;
      const visibility = isChange
        ? clamp((conflictT - 1.0) / 0.4) * heatOut
        : (nodeLock[tag.node] ?? 0) * (t >= T_CONFLICT ? 1 - smooth((t - T_CONFLICT) / 0.6) : 1);
      tag.el.style.opacity = String(clamp(visibility));
      if (visibility <= 0.01) continue;
      projected.copy(positions[tag.node] ?? new THREE.Vector3());
      graph.localToWorld(projected);
      projected.project(camera);
      const px = (projected.x * 0.5 + 0.5) * width;
      const py = (-projected.y * 0.5 + 0.5) * height;
      const flip = px > width * 0.52;
      tag.el.classList.toggle("is-flipped", flip);
      tag.el.style.transform = `translate(${(flip ? px - 16 : px + 16).toFixed(1)}px, ${(py - 14).toFixed(1)}px) ${flip ? "translateX(-100%)" : ""}`;
    }
  };

  const requestTick = (): void => {
    if (reduce || disposed || frame || !inView || document.hidden) return;
    frame = requestAnimationFrame(tick);
  };

  const tick = (now: number): void => {
    frame = 0;
    if (disposed || !inView || document.hidden) return;
    renderFrame((now - startTime) / 1000);
    requestTick();
  };

  const resize = (): void => {
    const width = Math.max(parent.clientWidth, 1);
    const height = Math.max(parent.clientHeight, 1);
    const aspect = width / height;
    renderer.setSize(width, height, false);
    camera.aspect = aspect;
    camera.position.set(0, 0.1, aspect < 0.85 ? 9.4 : aspect < 1.15 ? 8.4 : 7.6);
    camera.updateProjectionMatrix();
    viewportScale = aspect < 0.7 ? 0.9 : 1;
    if (reduce) renderFrame(STATIC_TIME);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const rect = parent.getBoundingClientRect();
    pointerTarget.set(
      clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
      clamp(-(((event.clientY - rect.top) / rect.height) * 2 - 1), -1, 1),
    );
  };
  const onPointerLeave = (): void => {
    pointerTarget.set(0, 0);
  };
  const onVisibility = (): void => requestTick();

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(parent);
  const intersectionObserver = new IntersectionObserver((entries) => {
    inView = entries[0]?.isIntersecting ?? true;
    if (inView) requestTick();
  });
  intersectionObserver.observe(parent);

  if (!reduce) {
    parent.addEventListener("pointermove", onPointerMove, { passive: true });
    parent.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("scroll", updateScroll, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    parent.removeEventListener("pointermove", onPointerMove);
    parent.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("scroll", updateScroll);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const tag of tags) tag.el.remove();
    graph.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    renderer.dispose();
  };
  window.addEventListener("pagehide", (event: PageTransitionEvent) => {
    if (!event.persisted) dispose();
  }, { once: true });

  startTime = performance.now();
  updateScroll();
  resize();
  renderFrame(reduce ? STATIC_TIME : 0);
  requestTick();
}
