// Builds src/data/campusPlaces.json + src/data/campusGraph.json from the real GMRIT geojson (public/data).
// Run:  node scripts/build-campus-data.mjs
import fs from 'node:fs';

const read = (f) => JSON.parse(fs.readFileSync(`public/data/${f}.geojson`, 'utf8')).features;
const buildings = read('buildings');
const entrances = read('building_entrances');
const areas = read('areas');
const paths = read('campus_paths');

// ---------- geometry helpers (local metres) ----------
const LAT0 = 18.465, KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110540;
const toM = ([lng, lat]) => [lng * KX, lat * KY];
const fromM = ([x, y]) => [x / KX, y / KY];
const dist = (a, b) => { const [ax, ay] = toM(a), [bx, by] = toM(b); return Math.hypot(ax - bx, ay - by); };

function centroid(ring) {
  const n = ring.length - 1;
  return [ring.slice(0, n).reduce((s, c) => s + c[0], 0) / n, ring.slice(0, n).reduce((s, c) => s + c[1], 0) / n];
}

// ---------- path graph ----------
const verts = [];            // [lng,lat]
const vkey = new Map();
const edges = new Map();     // "a-b" -> metres
const ekey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
function addVertex(c) {
  const k = `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  if (vkey.has(k)) return vkey.get(k);
  verts.push(c); vkey.set(k, verts.length - 1); return verts.length - 1;
}
function addEdge(a, b) { if (a !== b) edges.set(ekey(a, b), dist(verts[a], verts[b])); }

for (const f of paths) {
  const cs = f.geometry.coordinates;
  for (let i = 0; i < cs.length - 1; i++) addEdge(addVertex(cs[i]), addVertex(cs[i + 1]));
}
let segs = [...edges.keys()].map((k) => { const [a, b] = k.split('-').map(Number); return { a, b }; });

function snap(p) {
  let best = { d: Infinity };
  const [px, py] = toM(p);
  segs.forEach((s, i) => {
    const [ax, ay] = toM(verts[s.a]), [bx, by] = toM(verts[s.b]);
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
    if (d < best.d) best = { d, i, t, q: [qx, qy], L: Math.sqrt(L2) };
  });
  const s = segs[best.i];
  if (best.t * best.L < 1.5) return { v: s.a, d: best.d };
  if ((1 - best.t) * best.L < 1.5) return { v: s.b, d: best.d };
  const nv = verts.length; verts.push(fromM(best.q));
  edges.delete(ekey(s.a, s.b));
  addEdge(s.a, nv); addEdge(nv, s.b);
  segs[best.i] = { a: s.a, b: nv }; segs.push({ a: nv, b: s.b });
  return { v: nv, d: best.d };
}

// ---------- places ----------
const ACR = new Set(['NSS', 'NCC', 'CBT', 'DAV', 'GMRV', 'DAVT', 'CSE', 'ECE', 'DL', 'AIML']);
const tidy = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase()
  .replace(/\b[\w&]+/g, (w) => (ACR.has(w.toUpperCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)));
const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const splitAliases = (s) => [...new Set((s || '').split(',').map((x) => x.trim()).filter(Boolean))];

const places = [];
const byName = new Map();
function addPlace(p) { places.push(p); byName.set(norm(p.name), p); return p; }

const catForBuilding = (b) => {
  if (b.properties.type === 'lab' || b.properties.type === 'lab ') return 'labs';
  if (b.properties.type === 'building') return 'academic';
  if (/sports|gym/i.test(b.properties.name || '')) return 'sports';
  return 'services';
};

// 1. buildings
for (const b of buildings) {
  const pr = b.properties;
  const ents = entrances.filter((e) => e.properties.building_id === pr.building_id);
  const main = ents.find((e) => e.properties.type === 'main') || ents[0];
  const pos = main ? main.geometry.coordinates : centroid(b.geometry.coordinates[0]);
  const name = pr.name ? tidy(pr.name) : `Lab ${pr.building_id}`;
  const aliases = splitAliases(pr.aliases);
  const cat = catForBuilding(b);
  const floors = pr.floors || 1;
  addPlace({
    id: pr.building_id, name, floor: floors === 1 ? 'Single floor' : `${floors} floors`, floorId: 0,
    type: pr.type.trim() === 'building' ? 'building' : pr.type.trim() === 'connector' ? 'connector' : pr.type.trim() === 'lab' ? 'lab' : 'other',
    category: cat, floors, lng: pos[0], lat: pos[1], building: name, aliases,
    description: aliases.length ? `Also houses / known as: ${aliases.join(', ')}.` : `${name} on the GMRIT campus.`,
    isAccessible: true, closable: true,
    _extraEntrances: ents.filter((e) => e !== main),
  });
}
// extra entrances of multi-entrance buildings
for (const p of [...places]) {
  for (const e of p._extraEntrances || []) {
    const en = e.properties.name ? tidy(e.properties.name) : 'Side entrance';
    addPlace({ id: e.properties.entrance_id, name: `${p.name} – ${en}`, floor: 'Entrance', floorId: 0, type: 'entrance',
      category: p.category, lng: e.geometry.coordinates[0], lat: e.geometry.coordinates[1], building: p.name,
      aliases: [], description: `Additional entrance of ${p.name}.`, isAccessible: true, closable: false });
  }
  delete p._extraEntrances;
}

// 2. free-standing entrances (gates, areas, services)
const free = entrances.filter((e) => !e.properties.building_id);
const keep = [];
for (const e of free) {
  const nm = norm(e.properties.name);
  const dup = keep.find((k) => norm(k.properties.name) === nm && dist(k.geometry.coordinates, e.geometry.coordinates) < 15);
  if (!dup) keep.push(e);
}
const counts = {};
keep.forEach((e) => { const k = norm(e.properties.name); counts[k] = (counts[k] || 0) + 1; });
const seen = {};
const usedIds = new Set(places.map((p) => p.id));
for (const e of keep) {
  const pr = e.properties, k = norm(pr.name);
  seen[k] = (seen[k] || 0) + 1;
  let name = tidy(pr.name).replace(/Basket Ball/i, 'Basketball');
  if (counts[k] > 1) name += ` ${seen[k]}`;
  let id = pr.entrance_id === 'GOO6' ? 'G008' : pr.entrance_id;
  while (usedIds.has(id)) id += 'b';
  usedIds.add(id);
  const isGate = /gate/i.test(pr.name);
  const isGround = /ground|track|court|arena/i.test(pr.name);
  const isHostel = /hostel/i.test(pr.name);
  const isAssembly = /^main ground|ground$/i.test(name.replace(/ \d+$/, '')) && /ground/i.test(name);
  const category = isGate ? 'gates' : isHostel ? 'hostels' : isGround ? 'sports' : 'services';
  addPlace({
    id, name, floor: isGate ? 'Campus gate' : 'Outdoor', floorId: 0,
    type: isAssembly ? 'emergency' : isGate ? 'gate' : 'area', category: isAssembly ? 'emergency' : category,
    lng: e.geometry.coordinates[0], lat: e.geometry.coordinates[1], building: 'GMRIT Campus', aliases: [],
    description: isAssembly ? `${name} – open ground, emergency assembly point.` : `${name} on the GMRIT campus.`,
    isAccessible: true, closable: isGate,
  });
}

// 3. area polygons (hostels, grounds) that have no node yet: use boundary vertex nearest to a path
for (const a of areas) {
  const pr = a.properties, nm = norm(pr.name), aliases = splitAliases(pr.aliases);
  const existing = byName.get(nm) || places.find((p) => norm(p.name).replace(/ \d+$/, '') === nm);
  if (existing) { existing.aliases = [...new Set([...(existing.aliases || []), ...aliases])]; continue; }
  const ring = a.geometry.coordinates[0];
  let best = null;
  for (const c of ring) {
    const d = Math.min(...verts.map((v) => dist(v, c)));
    if (!best || d < best.d) best = { c, d };
  }
  const isHostel = pr.type === 'hostel';
  const isGround = pr.type === 'ground';
  const assembly = /ground/i.test(pr.name);
  addPlace({
    id: pr.area_id, name: tidy(pr.name), floor: 'Outdoor', floorId: 0,
    type: assembly ? 'emergency' : 'area', category: assembly ? 'emergency' : isHostel ? 'hostels' : isGround ? 'sports' : 'services',
    lng: best.c[0], lat: best.c[1], building: 'GMRIT Campus', aliases,
    description: assembly ? `${tidy(pr.name)} – open ground, emergency assembly point.` : `${tidy(pr.name)} on the GMRIT campus.`,
    isAccessible: true, closable: false,
  });
}

// ---------- attach every place to the path network ----------
const placeVertex = {};
const far = [];
for (const p of places) {
  const s = snap([p.lng, p.lat]);
  const pv = verts.length; verts.push([p.lng, p.lat]);
  edges.set(ekey(pv, s.v), Math.max(0.5, s.d));
  placeVertex[p.id] = pv;
  if (s.d > 40) far.push(`${p.id} ${p.name}: ${s.d.toFixed(0)} m from path`);
}

// connectivity check
const adj = verts.map(() => []);
for (const [k, d] of edges) { const [a, b] = k.split('-').map(Number); adj[a].push(b); adj[b].push(a); }
const reach = new Set([placeVertex[places[0].id]]); const st = [...reach];
while (st.length) { const x = st.pop(); for (const y of adj[x]) if (!reach.has(y)) { reach.add(y); st.push(y); } }
const unreachable = places.filter((p) => !reach.has(placeVertex[p.id]));

const r7 = (n) => Math.round(n * 1e7) / 1e7;
places.forEach((p) => { p.lng = r7(p.lng); p.lat = r7(p.lat); });
fs.writeFileSync('src/data/campusPlaces.json', JSON.stringify(places, null, 1));
fs.writeFileSync('src/data/campusGraph.json', JSON.stringify({
  vertices: verts.map((v) => [r7(v[0]), r7(v[1])]),
  edges: [...edges].map(([k, d]) => [...k.split('-').map(Number), Math.round(d * 10) / 10]),
  placeVertex,
}));
console.log(`places: ${places.length}, vertices: ${verts.length}, edges: ${edges.size}`);
console.log('unreachable:', unreachable.map((p) => p.name));
console.log('far from path (>40 m):', far);
const cat = {}; places.forEach((p) => (cat[p.category] = (cat[p.category] || 0) + 1)); console.log(cat);
console.log(places.map((p) => `${p.id}|${p.name}|${p.category}`).join('\n'));
