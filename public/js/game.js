import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";

const SHAPE_GEOMETRIES = {
  cube: () => new THREE.BoxGeometry(1, 1, 1),
  sphere: () => new THREE.SphereGeometry(0.6, 24, 16),
  cone: () => new THREE.ConeGeometry(0.6, 1.2, 24),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1.2, 24),
  torus: () => new THREE.TorusGeometry(0.5, 0.2, 16, 32),
};

const COLORS = [0xff6b6b, 0x4ecdc4, 0xffe66d, 0x95e1d3, 0xa78bfa];

// Half-height of each shape's geometry, i.e. the y a mesh needs to rest on
// the ground plane. Must match src/GameRoom.js's SHAPE_REST_Y.
const SHAPE_REST_Y = {
  cube: 0.5,
  sphere: 0.6,
  cone: 0.6,
  cylinder: 0.6,
  torus: 0.7,
};

const MOVE_SPEED = 4; // units/sec
const INPUT_SEND_HZ = 15;

export function startGame({ ws, players, myId }) {
  const canvas = document.getElementById("game-canvas");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1c26);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  camera.position.set(0, 12, 10);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x2a2d3a })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const meshes = new Map(); // playerId -> { mesh, target: {x,y,z,rotY} }

  players.forEach((p, i) => {
    const geometry = (SHAPE_GEOMETRIES[p.shape] || SHAPE_GEOMETRIES.cube)();
    const material = new THREE.MeshStandardMaterial({
      color: COLORS[i % COLORS.length],
    });
    const mesh = new THREE.Mesh(geometry, material);
    const restY = SHAPE_REST_Y[p.shape] ?? 0.6;
    mesh.position.set(0, restY, 0);
    scene.add(mesh);
    meshes.set(p.id, { mesh, target: { x: 0, y: restY, z: 0, rotY: 0 } });
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "state_update") {
      for (const p of msg.players) {
        const entry = meshes.get(p.id);
        if (!entry) continue;
        entry.target.x = p.x;
        entry.target.y = p.y;
        entry.target.z = p.z;
        entry.target.rotY = p.rotY;
      }
    } else if (msg.type === "player_left") {
      const entry = meshes.get(msg.id);
      if (entry) {
        scene.remove(entry.mesh);
        meshes.delete(msg.id);
      }
    } else if (msg.type === "session_closed") {
      alert("Session closed due to inactivity.");
      location.href = "/index.html";
    }
  });

  const keys = new Set();
  window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

  // simple touch drag for mobile
  let touchStart = null;
  let touchVec = { x: 0, z: 0 };
  window.addEventListener("touchstart", (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  });
  window.addEventListener("touchmove", (e) => {
    if (!touchStart) return;
    const dx = e.touches[0].clientX - touchStart.x;
    const dy = e.touches[0].clientY - touchStart.y;
    touchVec = { x: dx / 50, z: dy / 50 };
  });
  window.addEventListener("touchend", () => {
    touchStart = null;
    touchVec = { x: 0, z: 0 };
  });

  const myEntry = meshes.get(myId);
  let lastSend = 0;
  let lastFrame = performance.now();

  function tick(now) {
    const dt = Math.min((now - lastFrame) / 1000, 0.1);
    lastFrame = now;

    if (myEntry) {
      let dx = 0;
      let dz = 0;
      if (keys.has("w") || keys.has("arrowup")) dz -= 1;
      if (keys.has("s") || keys.has("arrowdown")) dz += 1;
      if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
      if (keys.has("d") || keys.has("arrowright")) dx += 1;
      dx += touchVec.x;
      dz += touchVec.z;

      const len = Math.hypot(dx, dz);
      if (len > 0) {
        dx /= len;
        dz /= len;
        myEntry.target.x += dx * MOVE_SPEED * dt;
        myEntry.target.z += dz * MOVE_SPEED * dt;
        myEntry.target.rotY = Math.atan2(dx, dz);

        // client-side prediction: render own player immediately
        myEntry.mesh.position.x = myEntry.target.x;
        myEntry.mesh.position.z = myEntry.target.z;
        myEntry.mesh.rotation.y = myEntry.target.rotY;
      }

      if (now - lastSend > 1000 / INPUT_SEND_HZ) {
        lastSend = now;
        ws.send(
          JSON.stringify({
            type: "input",
            x: myEntry.target.x,
            y: myEntry.target.y,
            z: myEntry.target.z,
            rotY: myEntry.target.rotY,
          })
        );
      }
    }

    for (const [id, entry] of meshes) {
      if (id === myId) continue;
      entry.mesh.position.lerp(
        new THREE.Vector3(entry.target.x, entry.target.y, entry.target.z),
        0.3
      );
      entry.mesh.rotation.y += (entry.target.rotY - entry.mesh.rotation.y) * 0.3;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
