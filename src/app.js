// ═══════════════════════════════════════════════════════════════
//  FORZA ACCESO — app.js  (main module)
// ═══════════════════════════════════════════════════════════════
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, onAuthStateChanged,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential,
  multiFactor, TotpMultiFactorGenerator
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, collection, onSnapshot, setDoc, updateDoc,
  getDoc, getDocs, deleteDoc, serverTimestamp, arrayUnion, query, where
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { firebaseConfig, DB_ROOT } from './firebase-config.js';

// ── Init ──────────────────────────────────────────────────────
const fbApp  = initializeApp(firebaseConfig);
const auth   = getAuth(fbApp);
const db     = getFirestore(fbApp);

// Register service worker
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── State ─────────────────────────────────────────────────────
let state = {
  authUser:     null,   // Firebase auth user
  profile:      null,   // Firestore user profile {role, name, assignedRoom}
  event:        null,   // current event doc
  rooms:        [],     // live array of room docs
  activeRoomId: null,   // which room this device is viewing
  scans:        [],     // live scans for active room (today)
  shifts:       [],     // live shifts for active room (today)
  appMode:      null,   // 'startup' | 'login' | 'operator' | 'admin'
  view:         'scanner', // current tab
  geo:          null,
  unsubscribers: [],
};

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const today = () => new Date().toISOString().slice(0, 10);
const timeNow = () => new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

function geo() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => {
    state.geo = { lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) };
  }, () => {}, { enableHighAccuracy: true });
}

// ── Firestore paths ───────────────────────────────────────────
const eventDocRef   = () => doc(db, DB_ROOT, 'current_event');
const roomsColRef   = () => collection(db, DB_ROOT, 'current_event', 'rooms');
const roomDocRef    = id => doc(db, DB_ROOT, 'current_event', 'rooms', id);
const usersColRef   = () => collection(db, DB_ROOT, 'users');
const userDocRef    = uid => doc(db, DB_ROOT, 'users', uid);
const scansColRef   = roomId => collection(db, DB_ROOT, 'current_event', 'rooms', roomId, 'scans');
const shiftsColRef  = roomId => collection(db, DB_ROOT, 'current_event', 'rooms', roomId, 'shifts');
const shiftDocRef   = (roomId, shiftId) => doc(db, DB_ROOT, 'current_event', 'rooms', roomId, 'shifts', shiftId);

// ── Auth state ────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  if (user) {
    state.authUser = user;
    const profileSnap = await getDoc(userDocRef(user.uid));
    if (profileSnap.exists()) {
      state.profile = profileSnap.data();
      startApp();
    } else {
      // First login — create profile (master admin path)
      renderFirstSetup();
    }
  } else {
    state.authUser = null;
    state.profile  = null;
    stopListeners();
    renderLogin();
  }
});

// ── Real-time listeners ───────────────────────────────────────
function stopListeners() {
  state.unsubscribers.forEach(u => u());
  state.unsubscribers = [];
}

function startListeners(roomId) {
  stopListeners();

  // Event doc
  const u1 = onSnapshot(eventDocRef(), snap => {
    state.event = snap.data() || {};
    rerender();
  });

  // Rooms
  const u2 = onSnapshot(roomsColRef(), snap => {
    state.rooms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!state.activeRoomId && state.rooms.length > 0)
      state.activeRoomId = state.profile?.assignedRoom || state.rooms[0].id;
    rerender();
  });

  // Scans for active room today
  const u3 = onSnapshot(
    query(scansColRef(roomId), where('day', '==', today())),
    snap => {
      state.scans = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
      rerender();
    }
  );

  // Shifts for active room today
  const u4 = onSnapshot(
    query(shiftsColRef(roomId), where('day', '==', today())),
    snap => {
      state.shifts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      rerender();
    }
  );

  state.unsubscribers = [u1, u2, u3, u4];
}

// ── QR / access logic ─────────────────────────────────────────
function parseQR(raw) {
  if (!raw) return null;
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  return { code: lines[0], name: lines[1], state: lines[2] || '', sport: lines[3] || '', categories: lines.slice(4), raw };
}

function checkAccess(parsed, access) {
  if (!parsed) return { result: 'unknown', reason: 'QR no reconocido', missing: [] };
  if (parsed.sport === 'Sin Servicio') return { result: 'denied', reason: 'Sin Servicio — no autorizado', missing: [] };
  const sA = access?.[parsed.sport];
  if (!sA) return { result: 'pending', reason: `Deporte no registrado: "${parsed.sport}"`, missing: ['sport'] };
  if (!sA.enabled) return { result: 'denied', reason: `${parsed.sport} no activo en este comedor`, missing: [] };
  const stA = sA.states?.[parsed.state];
  if (!stA) return { result: 'pending', reason: `Delegación no registrada: "${parsed.state}"`, missing: ['state'] };
  if (!stA.enabled) return { result: 'denied', reason: `${parsed.state} no tiene acceso hoy`, missing: [] };
  if (parsed.categories.length > 0) {
    const unknown = parsed.categories.filter(c => stA.cats?.[c] === undefined);
    if (unknown.length) return { result: 'pending', reason: `Categoría nueva: "${unknown[0]}"`, missing: ['cat', unknown] };
    const ok = parsed.categories.some(c => stA.cats?.[c]?.enabled);
    if (!ok) return { result: 'denied', reason: 'Categoría no activa hoy', missing: [] };
  }
  return { result: 'granted', reason: `${parsed.sport} · ${parsed.state}`, missing: [] };
}

function mergeAccess(parsed, access) {
  const n = JSON.parse(JSON.stringify(access || {}));
  if (!n[parsed.sport]) n[parsed.sport] = { enabled: true, states: {} };
  else n[parsed.sport].enabled = true;
  if (!n[parsed.sport].states[parsed.state]) n[parsed.sport].states[parsed.state] = { enabled: true, cats: {} };
  else n[parsed.sport].states[parsed.state].enabled = true;
  const cats = parsed.categories.length ? parsed.categories : ['General'];
  cats.forEach(c => {
    if (!n[parsed.sport].states[parsed.state].cats[c])
      n[parsed.sport].states[parsed.state].cats[c] = { enabled: true };
    else n[parsed.sport].states[parsed.state].cats[c].enabled = true;
  });
  return n;
}

// ── Active shift helper ───────────────────────────────────────
function getOpenShift() {
  return state.shifts.find(s => s.status === 'open') || null;
}

// ── Write scan to Firestore ───────────────────────────────────
async function writeScan(parsed, result, type = 'scan') {
  const room = state.rooms.find(r => r.id === state.activeRoomId);
  if (!room) return;
  const openShift = getOpenShift();
  const scanRef = doc(scansColRef(state.activeRoomId));
  await setDoc(scanRef, {
    parsed, result, type,
    shiftId:   openShift?.id || null,
    shiftName: openShift?.name || 'Sin turno',
    day:       today(),
    time:      timeNow(),
    ts:        serverTimestamp(),
    geo:       state.geo || null,
    roomId:    state.activeRoomId,
    roomName:  room.name,
  });
}

// ── Handle scan decision ──────────────────────────────────────
let pendingScan = null;
let deniedProfiles = new Set();

function profileKey(p) {
  return `${p.sport}||${p.state}||${(p.categories || []).sort().join('|')}`;
}

async function processScan(raw) {
  const parsed  = parseQR(raw);
  const room    = state.rooms.find(r => r.id === state.activeRoomId);
  const access  = room?.access || {};
  const result  = checkAccess(parsed, access);

  if (parsed && result.result === 'pending' && deniedProfiles.has(profileKey(parsed))) {
    const ar = { result: 'denied', reason: 'Perfil rechazado anteriormente' };
    await writeScan(parsed, ar);
    showScanResult(parsed, ar);
    return;
  }

  if (result.result === 'pending') {
    pendingScan = { parsed, result };
    renderPendingCard(parsed, result);
    return;
  }

  await writeScan(parsed, result);
  showScanResult(parsed, result);
}

async function decidePending(action) {
  if (!pendingScan) return;
  const { parsed } = pendingScan;
  pendingScan = null;

  if (action === 'grant') {
    const room  = state.rooms.find(r => r.id === state.activeRoomId);
    const newAcc = mergeAccess(parsed, room?.access || {});
    await updateDoc(roomDocRef(state.activeRoomId), { access: newAcc });
    const gr = { result: 'granted', reason: 'Aprobado y agregado al sistema' };
    await writeScan(parsed, gr);
    showScanResult(parsed, gr);
  } else {
    deniedProfiles.add(profileKey(parsed));
    const dr = { result: 'denied', reason: 'Denegado manualmente' };
    await writeScan(parsed, dr);
    showScanResult(parsed, dr);
  }
}

// ── Reports / exports ─────────────────────────────────────────
function dlFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function exportForzaCSV(roomId) {
  const room  = state.rooms.find(r => r.id === roomId);
  const snap  = await getDocs(scansColRef(roomId));
  const scans = snap.docs.map(d => d.data()).filter(s => s.type === 'scan');
  const rows  = [['Fecha','Turno','Hora','Resultado','Codigo','Nombre','Estado','Deporte','Categorias','Comedor','Lat','Lng']];
  scans.forEach(s => rows.push([
    s.day, s.shiftName, s.time, s.result?.result || '',
    s.parsed?.code || '', s.parsed?.name || '',
    s.parsed?.state || '', s.parsed?.sport || '',
    (s.parsed?.categories || []).join(' | '),
    room?.name || '', s.geo?.lat || '', s.geo?.lng || ''
  ]));
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  dlFile('\uFEFF' + csv, `Forza_${room?.name || 'comedor'}_${today()}.csv`, 'text/csv;charset=utf-8');
}

async function exportGovReport(roomId, shiftId) {
  const room      = state.rooms.find(r => r.id === roomId);
  const shiftSnap = await getDoc(shiftDocRef(roomId, shiftId));
  const shift     = { id: shiftId, ...shiftSnap.data() };
  const allScans  = (await getDocs(scansColRef(roomId))).docs.map(d => d.data()).filter(s => s.shiftId === shiftId);
  const present   = allScans.filter(s => s.type === 'scan' && (s.result?.result === 'granted' || s.result?.result === 'auto-added'));
  const noShows   = allScans.filter(s => s.type === 'noshow' || s.type === 'manual-noshow');
  const geo       = shift.location || state.geo;
  const geoStr    = geo?.lat ? `${geo.lat}, ${geo.lng} (±${geo.acc}m)` : 'No disponible';
  const eventName = state.event?.name || 'Evento';

  const rows = (arr, offset) => arr.map((s, i) => `
    <tr>
      <td>${offset + i + 1}</td>
      <td>${s.parsed?.code || ''}</td>
      <td><strong>${s.parsed?.name || '—'}</strong></td>
      <td>${s.parsed?.state || ''}</td>
      <td>${s.parsed?.sport || ''}</td>
      <td>${(s.parsed?.categories || []).join(', ') || '—'}</td>
      <td>${s.time || '—'}</td>
      <td style="color:${s.type === 'scan' ? '#1D9E75' : '#BA7517'};font-weight:600">${s.type === 'scan' ? '✓ Presente' : '○ No se presentó'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Reporte Oficial — ${eventName}</title>
<style>
  body{font-family:Georgia,serif;max-width:900px;margin:40px auto;padding:0 24px;color:#1a1a1a}
  .hdr{text-align:center;border-bottom:2px solid #1a1a1a;padding-bottom:20px;margin-bottom:28px}
  .brand{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#666;margin-bottom:8px}
  h1{font-size:22px;margin-bottom:4px}
  .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
  .mbox{background:#f8f8f5;border:1px solid #e0e0d8;border-radius:8px;padding:14px;text-align:center}
  .mbox .n{font-size:28px;font-weight:700;margin-bottom:4px}
  .mbox .l{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em}
  .irow{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px;font-size:13px}
  .ii .k{font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
  .ii .v{font-size:13px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px}
  th{background:#1a1a1a;color:#fff;padding:7px 10px;text-align:left;font-weight:600;font-size:11px;text-transform:uppercase}
  td{padding:6px 10px;border-bottom:1px solid #e8e8e0}
  tr:nth-child(even){background:#fafaf8}
  .sec{font-size:14px;font-weight:700;margin:20px 0 10px;border-left:3px solid #1a1a1a;padding-left:10px}
  .sigs{margin-top:48px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
  .sig{border-top:1px solid #1a1a1a;padding-top:8px;font-size:11px;color:#666;text-align:center}
  .footer{margin-top:32px;padding-top:16px;border-top:1px solid #e0e0d8;font-size:11px;color:#888;text-align:center;line-height:1.8}
  @media print{.noprint{display:none}}
</style></head><body>
<div class="noprint" style="text-align:right;margin-bottom:16px">
  <button onclick="window.print()" style="padding:8px 16px;background:#185FA5;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">Imprimir / Guardar PDF</button>
</div>
<div class="hdr">
  <div class="brand">Reporte Oficial de Servicio de Alimentación</div>
  <h1>${eventName}</h1>
  <div style="font-size:14px;color:#444;margin-top:4px">${room?.name || ''} — ${shift.name} — ${shift.day}</div>
</div>
<div class="irow">
  <div class="ii"><div class="k">Evento</div><div class="v">${eventName}</div></div>
  <div class="ii"><div class="k">Comedor</div><div class="v">${room?.name || ''}</div></div>
  <div class="ii"><div class="k">Turno</div><div class="v">${shift.name}</div></div>
  <div class="ii"><div class="k">Fecha</div><div class="v">${shift.day}</div></div>
  <div class="ii"><div class="k">Horario</div><div class="v">${shift.start}–${shift.end}</div></div>
  <div class="ii"><div class="k">Apertura</div><div class="v">${shift.openedAt || '—'}</div></div>
  <div class="ii"><div class="k">Cierre</div><div class="v">${shift.closedAt || '—'}</div></div>
  <div class="ii"><div class="k">Ubicación</div><div class="v" style="font-size:11px">${geoStr}</div></div>
</div>
<div class="meta">
  <div class="mbox"><div class="n" style="color:#1D9E75">${present.length}</div><div class="l">Presentes</div></div>
  <div class="mbox"><div class="n" style="color:#BA7517">${noShows.length}</div><div class="l">No se presentaron</div></div>
  <div class="mbox"><div class="n">${present.length + noShows.length}</div><div class="l">Total garantizado</div></div>
</div>
<div class="sec">Comensales presentes (${present.length})</div>
<table><thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Delegación</th><th>Deporte</th><th>Categoría</th><th>Hora</th><th>Estado</th></tr></thead>
<tbody>${rows(present, 0) || '<tr><td colspan="8" style="text-align:center;padding:14px;color:#999">Sin registros</td></tr>'}</tbody></table>
${noShows.length > 0 ? `<div class="sec">No se presentaron — cuentan para el garantizado (${noShows.length})</div>
<table><thead><tr><th>#</th><th>Código</th><th>Nombre</th><th>Delegación</th><th>Deporte</th><th>Categoría</th><th>Hora</th><th>Estado</th></tr></thead>
<tbody>${rows(noShows, present.length)}</tbody></table>` : ''}
<div class="sigs">
  <div><div class="sig">Firma y sello — Responsable Forza</div></div>
  <div><div class="sig">Firma y sello — Representante ${eventName}</div></div>
</div>
<div class="footer">
  Generado el ${new Date().toLocaleString('es-MX')} · Forza Control de Acceso
  ${geo?.lat ? `<br>Coordenadas: ${geoStr} — <a href="https://maps.google.com/?q=${geo.lat},${geo.lng}" target="_blank">Ver en mapa</a>` : ''}
</div>
</body></html>`;

  dlFile(html, `Reporte_Oficial_${room?.name || ''}_${shift.name}_${shift.day}.html`, 'text/html;charset=utf-8');
}

// ── Render engine (lightweight, no framework) ─────────────────
let scanCooldown = false;

function rerender() {
  const root = document.getElementById('root');
  if (!root) return;

  if (!state.authUser) { renderLogin(); return; }
  if (!state.profile)  { return; }

  const isAdmin = state.profile.role === 'master_admin' || state.profile.role === 'admin';
  const room    = state.rooms.find(r => r.id === state.activeRoomId);

  root.innerHTML = '';
  root.appendChild(buildApp(isAdmin, room));
}

function buildApp(isAdmin, room) {
  const wrap = el('div', 'app');

  // Header
  const hdr = el('div', 'hdr');
  hdr.innerHTML = `
    <div>
      <div class="hdr-title">${state.event?.name || 'Forza Scans'}</div>
      <div class="hdr-sub">${room?.name || '—'}</div>
    </div>
    <div class="hdr-right">
      <span class="badge ${isAdmin ? 'badge-blue' : 'badge-amber'}">${isAdmin ? 'Admin' : 'Op'}</span>
      <span class="badge badge-green">${Object.values(room?.access || {}).filter(s => s.enabled).length} deportes</span>
      <button class="icon-btn" id="btn-signout" title="Cerrar sesión">⏻</button>
    </div>`;
  wrap.appendChild(hdr);

  // Room switcher (if more than one room)
  if (state.rooms.length > 1) {
    const rb = el('div', 'room-bar');
    state.rooms.forEach(r => {
      const btn = el('button', `room-tab ${r.id === state.activeRoomId ? 'on' : ''}`);
      btn.textContent = r.name;
      btn.onclick = () => switchRoom(r.id, isAdmin);
      rb.appendChild(btn);
    });
    wrap.appendChild(rb);
  }

  // Shift bar
  wrap.appendChild(buildShiftBar(room, isAdmin));

  // Tab bar (admin only)
  if (isAdmin) {
    const tabs = el('div', 'tabs');
    [['scanner','Escáner'],['reports','Reportes'],['room-admin','Comedor'],['global-admin','Evento']].forEach(([id, label]) => {
      const btn = el('button', `tab ${state.view === id ? 'on' : ''}`);
      btn.textContent = label;
      btn.onclick = () => { state.view = id; rerender(); };
      tabs.appendChild(btn);
    });
    wrap.appendChild(tabs);
  }

  // Main content
  const pg = el('div', 'pg');
  if (state.view === 'scanner' || !isAdmin) pg.appendChild(buildScanner(room, isAdmin));
  else if (state.view === 'reports')        pg.appendChild(buildReports(room));
  else if (state.view === 'room-admin')     pg.appendChild(buildRoomAdmin(room));
  else if (state.view === 'global-admin')   pg.appendChild(buildGlobalAdmin());
  wrap.appendChild(pg);

  // Wire signout
  setTimeout(() => {
    const so = document.getElementById('btn-signout');
    if (so) so.onclick = () => { if (confirm('¿Cerrar sesión?')) signOut(auth); };
  }, 0);

  return wrap;
}

// ── Room switcher ─────────────────────────────────────────────
async function switchRoom(roomId, isAdmin) {
  if (isAdmin) {
    state.activeRoomId = roomId;
    startListeners(roomId);
    rerender();
    return;
  }
  // Operator: require room PIN
  const pin = prompt('Ingresa el PIN de este comedor para cambiar:');
  if (!pin) return;
  const room = state.rooms.find(r => r.id === roomId);
  if (room?.pin && room.pin !== pin) { alert('PIN incorrecto.'); return; }
  state.activeRoomId = roomId;
  // Update assigned room in profile
  await updateDoc(userDocRef(state.authUser.uid), { assignedRoom: roomId });
  startListeners(roomId);
  rerender();
}

// ── Shift bar ─────────────────────────────────────────────────
function buildShiftBar(room, isAdmin) {
  const bar = el('div', 'shift-bar-wrap');
  if (!room) return bar;

  const SHIFTS = [
    { id: 'desayuno', name: 'Desayuno', emoji: '🌅', defaultStart: '07:00', defaultEnd: '10:00' },
    { id: 'comida',   name: 'Comida',   emoji: '☀️',  defaultStart: '13:00', defaultEnd: '16:00' },
    { id: 'cena',     name: 'Cena',     emoji: '🌙',  defaultStart: '19:00', defaultEnd: '22:00' },
  ];

  const todayShifts = state.shifts; // already filtered to today
  const pills = el('div', 'shift-pills');

  SHIFTS.forEach(def => {
    const sh = todayShifts.find(s => s.shiftKey === def.id);
    const pill = el('div', 'shift-pill');
    const status = sh?.status || 'pending';

    pill.innerHTML = `
      <div class="sp-name">${def.emoji} ${def.name}</div>
      <div class="sp-time">${sh?.start || def.defaultStart}–${sh?.end || def.defaultEnd}</div>
      <div class="sp-count">${(sh?.scanCount || 0)} scans</div>`;

    if (isAdmin) {
      const btn = el('button', `shift-btn shift-btn-${status}`);
      btn.textContent = status === 'pending' ? 'Abrir' : status === 'open' ? 'Cerrar' : '✓';
      btn.disabled = status === 'closed';
      btn.onclick = () => status === 'pending' ? openShiftModal(def, sh, room) : closeShiftModal(sh, room);
      pill.appendChild(btn);
    } else {
      const lbl = el('div', `shift-lbl shift-lbl-${status}`);
      lbl.textContent = status === 'open' ? '● Abierto' : status === 'closed' ? '✓ Cerrado' : 'Pendiente';
      pill.appendChild(lbl);
    }
    pills.appendChild(pill);
  });

  const open = todayShifts.find(s => s.status === 'open');
  if (open) {
    const notice = el('div', 'shift-notice');
    notice.textContent = `● Turno abierto: ${open.name}`;
    bar.appendChild(notice);
  }
  bar.appendChild(pills);
  return bar;
}

// ── Shift modals ──────────────────────────────────────────────
function openShiftModal(def, existing, room) {
  showModal(`
    <div class="modal-title">Abrir turno — ${def.emoji} ${def.name}</div>
    <div class="modal-sub">Confirma el horario y la cantidad garantizada de comensales.</div>
    <label class="form-label">Horario</label>
    <div class="mrow">
      <input class="minput" id="sh-start" type="time" value="${existing?.start || def.defaultStart}"/>
      <span style="align-self:center;color:var(--text2);font-size:13px;flex-shrink:0">a</span>
      <input class="minput" id="sh-end" type="time" value="${existing?.end || def.defaultEnd}"/>
    </div>
    <label class="form-label">Cantidad garantizada de comensales</label>
    <input class="minput" id="sh-expected" type="number" min="0" value="${existing?.expectedCount || 0}" style="width:100%;margin-bottom:18px"/>
    <div style="display:flex;gap:8px">
      <button class="btn-sm btn-sm-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn-sm btn-sm-green" onclick="confirmOpenShift('${def.id}','${def.name}','${def.emoji}')">Abrir turno</button>
    </div>`, room);
}

window.confirmOpenShift = async (defId, name, emoji) => {
  const room = state.rooms.find(r => r.id === state.activeRoomId);
  if (!room) return;
  const shiftRef = doc(shiftsColRef(state.activeRoomId));
  await setDoc(shiftRef, {
    shiftKey:      defId,
    name, emoji,
    start:         $('sh-start').value,
    end:           $('sh-end').value,
    expectedCount: Number($('sh-expected').value),
    status:        'open',
    openedAt:      timeNow(),
    closedAt:      null,
    scanCount:     0,
    day:           today(),
    location:      state.geo || null,
  });
  closeModal();
};

function closeShiftModal(shift, room) {
  // Build suggested no-shows from active access combos
  const acc = room?.access || {};
  const suggested = [];
  Object.entries(acc).forEach(([sport, sObj]) => {
    if (!sObj.enabled) return;
    Object.entries(sObj.states || {}).forEach(([state2, stObj]) => {
      if (!stObj.enabled) return;
      Object.entries(stObj.cats || {}).forEach(([cat, catObj]) => {
        if (!catObj.enabled) return;
        suggested.push({ sport, state: state2, cat, key: `${sport}|${state2}|${cat}` });
      });
    });
  });

  const presentScans = state.scans.filter(s => s.shiftId === shift.id && s.type === 'scan');
  const noShowCount  = (shift.expectedCount || 0) - presentScans.length;

  showModal(`
    <div class="modal-title">Cerrar turno — ${shift.emoji} ${shift.name}</div>
    <div class="modal-sub">Revisa y confirma los no-shows antes de cerrar.</div>
    <div class="stats-row-3" style="margin-bottom:14px">
      <div class="stat-card"><div class="stat-num" style="color:var(--green-text)">${presentScans.length}</div><div class="stat-label">Presentes</div></div>
      <div class="stat-card"><div class="stat-num" style="color:var(--amber-text)" id="ns-count">0</div><div class="stat-label">No-shows</div></div>
      <div class="stat-card"><div class="stat-num" id="total-count">${presentScans.length}</div><div class="stat-label">Total garantizado</div></div>
    </div>
    <label class="form-label">Cantidad garantizada (ajustable)</label>
    <input class="minput" id="expected-adj" type="number" value="${shift.expectedCount || 0}" style="width:100%;margin-bottom:12px"/>
    ${suggested.length > 0 ? `
    <label class="form-label">Perfiles elegibles no presentes</label>
    <div style="max-height:160px;overflow-y:auto;border:0.5px solid var(--border);border-radius:var(--radius);margin-bottom:12px" id="suggested-list">
      ${suggested.map(s => `
        <label style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:0.5px solid var(--border);cursor:pointer;font-size:12px">
          <input type="checkbox" class="ns-check" data-key="${s.key}" data-sport="${s.sport}" data-state="${s.state}" data-cat="${s.cat}" onchange="updateNSCount(${presentScans.length})"/>
          <span><strong>${s.sport}</strong> · ${s.state} · ${s.cat}</span>
        </label>`).join('')}
    </div>` : ''}
    <label class="form-label">Agregar no-show manual</label>
    <div style="background:var(--surface2);border-radius:var(--radius);padding:10px;margin-bottom:12px">
      <input class="minput" id="ns-name" placeholder="Nombre" style="width:100%;margin-bottom:6px"/>
      <div class="mrow">
        <input class="minput" id="ns-sport" placeholder="Deporte"/>
        <input class="minput" id="ns-state" placeholder="Estado"/>
      </div>
      <div class="mrow">
        <input class="minput" id="ns-cat" placeholder="Categoría"/>
        <button class="mbtn" onclick="addManualNS()">+ Agregar</button>
      </div>
      <div id="manual-ns-list"></div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn-sm btn-sm-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn-sm btn-sm-red" onclick="confirmCloseShift('${shift.id}')">Cerrar turno</button>
    </div>`, room);
}

let manualNSEntries = [];
window.addManualNS = () => {
  const name  = $('ns-name')?.value.trim();
  const sport = $('ns-sport')?.value.trim();
  const state2 = $('ns-state')?.value.trim();
  const cat   = $('ns-cat')?.value.trim();
  if (!name) return;
  manualNSEntries.push({ name, sport, state: state2, cat, id: Date.now() });
  if ($('ns-name')) $('ns-name').value = '';
  const list = $('manual-ns-list');
  if (list) list.innerHTML = manualNSEntries.map(e =>
    `<div style="font-size:12px;padding:5px 0;border-top:0.5px solid var(--border)">${e.name} — ${e.sport} · ${e.state}</div>`).join('');
};

window.updateNSCount = (present) => {
  const checked = document.querySelectorAll('.ns-check:checked').length + manualNSEntries.length;
  const nsEl = $('ns-count'); const totEl = $('total-count');
  if (nsEl) nsEl.textContent = checked;
  if (totEl) totEl.textContent = present + checked;
};

window.confirmCloseShift = async (shiftId) => {
  const checked = Array.from(document.querySelectorAll('.ns-check:checked')).map(c => ({
    parsed: { name: '(Perfil elegible)', code: '', state: c.dataset.state, sport: c.dataset.sport, categories: [c.dataset.cat] },
    result: { result: 'noshow' }, type: 'noshow', day: today(),
    shiftId, shiftName: '', time: '—', ts: serverTimestamp(), geo: state.geo || null,
    roomId: state.activeRoomId, roomName: '',
  }));

  const manual = manualNSEntries.map(e => ({
    parsed: { name: e.name, code: '', state: e.state, sport: e.sport, categories: e.cat ? [e.cat] : [] },
    result: { result: 'manual-noshow' }, type: 'manual-noshow', day: today(),
    shiftId, shiftName: '', time: '—', ts: serverTimestamp(), geo: state.geo || null,
    roomId: state.activeRoomId, roomName: '',
  }));

  // Write no-shows to scans collection
  await Promise.all([...checked, ...manual].map(ns => setDoc(doc(scansColRef(state.activeRoomId)), ns)));

  // Close the shift doc
  await updateDoc(shiftDocRef(state.activeRoomId, shiftId), {
    status:    'closed',
    closedAt:  timeNow(),
    expectedCount: Number($('expected-adj')?.value || 0),
    location:  state.geo || null,
  });

  manualNSEntries = [];
  closeModal();
};

// ── Modal system ──────────────────────────────────────────────
function showModal(html, room) {
  let m = $('app-modal');
  if (!m) {
    m = el('div', 'modal-overlay', '');
    m.id = 'app-modal';
    document.body.appendChild(m);
  }
  m.innerHTML = `<div class="modal-box">${html}</div>`;
  m.style.display = 'flex';
}

window.closeModal = () => {
  const m = $('app-modal');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
};

// ── Scanner UI ────────────────────────────────────────────────
let videoStream = null;
let rafId = null;
let lastResultEl = null;

function buildScanner(room, isAdmin) {
  const wrap = el('div', '');
  const openShift = getOpenShift();

  if (!openShift) {
    const warn = el('div', 'ibar ibar-a');
    warn.textContent = isAdmin ? 'No hay turno abierto. Abre un turno para comenzar.' : 'Esperando apertura del turno…';
    wrap.appendChild(warn);
  }

  if (state.geo?.lat) {
    const geoEl = el('div', 'geo-pill');
    geoEl.textContent = `📍 ${state.geo.lat}, ${state.geo.lng} ±${state.geo.acc}m`;
    wrap.appendChild(geoEl);
  }

  // Stats
  const todayScans = state.scans.filter(s => s.type === 'scan');
  const stats = el('div', 'stats-row');
  stats.innerHTML = `
    <div class="stat-card"><div class="stat-num" style="color:var(--green-text)">${todayScans.filter(s=>s.result?.result==='granted'||s.result?.result==='auto-added').length}</div><div class="stat-label">Presentes hoy</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--red-text)">${todayScans.filter(s=>s.result?.result==='denied').length}</div><div class="stat-label">Denegados</div></div>`;
  wrap.appendChild(stats);

  // Camera box
  const camBox = el('div', 'scan-box');
  camBox.id = 'cam-box';
  camBox.style.height = '170px';
  camBox.style.display = 'flex';
  camBox.style.alignItems = 'center';
  camBox.style.justifyContent = 'center';
  camBox.innerHTML = '<span style="color:rgba(255,255,255,0.3);font-size:13px">Cámara inactiva</span>';
  wrap.appendChild(camBox);

  const vid = document.createElement('video');
  vid.id = 'qr-video'; vid.playsInline = true; vid.muted = true;
  vid.style.cssText = 'width:100%;display:none';
  const cvs = document.createElement('canvas');
  cvs.id = 'qr-canvas'; cvs.style.display = 'none';
  wrap.appendChild(vid); wrap.appendChild(cvs);

  // Start / stop button
  const startBtn = el('button', 'btn btn-blue', 'Iniciar escáner');
  startBtn.id = 'scan-toggle';
  wrap.appendChild(startBtn);

  // Manual input
  const manRow = el('div', 'mrow');
  manRow.innerHTML = '<input class="minput" id="man-input" placeholder="Código manual…"/><button class="mbtn" id="man-btn">Verificar</button>';
  wrap.appendChild(manRow);

  // Result area
  const resultArea = el('div', '');
  resultArea.id = 'result-area';
  wrap.appendChild(resultArea);

  // Log
  const logTitle = el('div', 'lt');
  logTitle.textContent = openShift ? `Turno actual — ${openShift.name}` : 'Registro de hoy';
  wrap.appendChild(logTitle);

  const logWrap = el('div', '');
  const shiftScans = openShift ? state.scans.filter(s => s.shiftId === openShift.id) : state.scans;
  if (shiftScans.length === 0) {
    logWrap.innerHTML = '<div class="lempty">Sin registros aún</div>';
  } else {
    shiftScans.slice(0, 40).forEach(sc => {
      const li = el('div', 'li');
      const res = sc.result?.result || 'unknown';
      li.innerHTML = `
        <div class="ld ${res === 'auto-added' ? 'granted' : res}"></div>
        <div style="flex:1;min-width:0">
          <div class="ln">${sc.parsed?.name || 'Desconocido'}</div>
          <div class="lm">${sc.parsed?.sport || ''} · ${sc.parsed?.state || ''}</div>
        </div>
        <div class="ltime">${sc.time || ''}</div>`;
      logWrap.appendChild(li);
    });
  }
  wrap.appendChild(logWrap);

  // Wire events after render
  setTimeout(() => {
    const toggle = $('scan-toggle');
    const manBtn = $('man-btn');
    const manIn  = $('man-input');
    let scanning = false;

    if (toggle) toggle.onclick = async () => {
      if (!scanning) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          videoStream = stream;
          const v = $('qr-video');
          const box = $('cam-box');
          if (v && box) {
            v.srcObject = stream; v.style.display = 'block';
            box.style.height = 'auto'; box.style.display = 'block';
            box.innerHTML = '';
            box.appendChild(v);
            const overlay = el('div', 'scan-overlay');
            overlay.innerHTML = '<div class="scan-frame"><div class="scan-line"></div></div>';
            box.appendChild(overlay);
            const hint = el('div', 'scan-hint', 'Apunta al QR del acreditado');
            box.appendChild(hint);
            await v.play();
            scanning = true;
            toggle.textContent = 'Detener escáner';
            toggle.className = 'btn btn-ghost';
            tickScan(v, $('qr-canvas'));
          }
        } catch { alert('No se pudo acceder a la cámara.'); }
      } else {
        stopCamera();
        scanning = false;
        toggle.textContent = 'Iniciar escáner';
        toggle.className = 'btn btn-blue';
        const box = $('cam-box');
        if (box) { box.style.height = '170px'; box.style.display = 'flex'; box.innerHTML = '<span style="color:rgba(255,255,255,0.3);font-size:13px">Cámara inactiva</span>'; }
      }
    };

    if (manBtn) manBtn.onclick = () => { const v = manIn?.value?.trim(); if (v) { handleScan(v); manIn.value = ''; } };
    if (manIn)  manIn.onkeydown = e => { if (e.key === 'Enter') { const v = manIn.value.trim(); if (v) { handleScan(v); manIn.value = ''; } } };
  }, 0);

  return wrap;
}

function tickScan(video, canvas) {
  if (!video || video.readyState < 2) { rafId = requestAnimationFrame(() => tickScan(video, canvas)); return; }
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0);
  try {
    const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code?.data) handleScan(code.data);
  } catch {}
  rafId = requestAnimationFrame(() => tickScan(video, canvas));
}

function stopCamera() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
}

async function handleScan(raw) {
  if (scanCooldown) return;
  scanCooldown = true;
  await processScan(raw);
  setTimeout(() => { scanCooldown = false; }, 2800);
}

function showScanResult(parsed, result) {
  const area = $('result-area');
  if (!area) return;
  const labels  = { granted: 'Acceso permitido', denied: 'Acceso denegado', 'auto-added': 'Aprobado y registrado' };
  const icons   = { granted: '✓', denied: '✕', 'auto-added': '✓' };
  const cls     = result.result === 'auto-added' ? 'granted' : result.result;
  area.innerHTML = `
    <div class="rc ${cls}">
      <div class="rh"><div class="ri">${icons[result.result] || '?'}</div><div class="rs">${labels[result.result] || result.result}</div></div>
      ${parsed ? `<div class="rname">${parsed.name}</div><div class="rcode">${parsed.code}</div>
        <div class="pills">
          ${parsed.state ? `<span class="pill pill-e">${parsed.state}</span>` : ''}
          ${parsed.sport ? `<span class="pill pill-s">${parsed.sport}</span>` : ''}
          ${(parsed.categories || []).slice(0,2).map(c => `<span class="pill pill-c">${c}</span>`).join('')}
        </div>` : ''}
      <div class="rr">${result.reason || ''}</div>
    </div>`;
}

function renderPendingCard(parsed, result) {
  const area = $('result-area');
  if (!area) return;
  const isAdmin = state.profile?.role === 'master_admin' || state.profile?.role === 'admin';
  area.innerHTML = `
    <div class="rc pending">
      <div class="rh"><div class="ri">?</div><div class="rs">Acreditado no registrado</div></div>
      ${parsed ? `<div class="rname">${parsed.name}</div><div class="rcode">${parsed.code}</div>
        <div class="pills">
          ${parsed.state ? `<span class="pill pill-e">${parsed.state}</span>` : ''}
          ${parsed.sport ? `<span class="pill pill-s">${parsed.sport}</span>` : ''}
          ${(parsed.categories || []).slice(0,2).map(c => `<span class="pill pill-c">${c}</span>`).join('')}
        </div>` : ''}
      <div class="rr">${result.reason}</div>
      ${isAdmin ? `
        <div class="pending-info">Al aprobar, este perfil se agrega al sistema. Todos los siguientes con el mismo deporte, estado y categoría pasarán automáticamente.</div>
        <div class="decision-btns">
          <button class="btn-sm btn-sm-green" onclick="window._decidePending('grant')">✓ Aprobar y agregar</button>
          <button class="btn-sm btn-sm-red" onclick="window._decidePending('deny')">✕ Denegar</button>
        </div>` :
        '<div class="ibar ibar-a" style="margin-top:8px;margin-bottom:0">Contacta al administrador.</div>'}
    </div>`;
  window._decidePending = (action) => decidePending(action);
}

// ── Reports UI ────────────────────────────────────────────────
function buildReports(room) {
  const wrap = el('div', '');
  const title = el('div', 'sl', `REPORTES — ${room?.name || ''}`);
  wrap.appendChild(title);

  if (state.shifts.length === 0) {
    wrap.innerHTML += '<div class="lempty">No hay turnos registrados aún.</div>';
    return wrap;
  }

  state.shifts.sort((a, b) => a.shiftKey?.localeCompare(b.shiftKey)).forEach(sh => {
    const shiftScans   = state.scans.filter(s => s.shiftId === sh.id);
    const present      = shiftScans.filter(s => s.type === 'scan' && (s.result?.result === 'granted' || s.result?.result === 'auto-added')).length;
    const noShows      = shiftScans.filter(s => s.type === 'noshow' || s.type === 'manual-noshow').length;

    const card = el('div', 'shift-record');
    card.innerHTML = `
      <div class="shift-record-header">
        <div>
          <div class="shift-record-title">${sh.emoji} ${sh.name} <span class="badge ${sh.status==='open'?'badge-green':sh.status==='closed'?'badge-blue':'badge-amber'}">${sh.status==='open'?'Abierto':sh.status==='closed'?'Cerrado':'Pendiente'}</span></div>
          <div class="shift-record-meta">${sh.start}–${sh.end} · ${sh.day}${sh.openedAt ? ' · Abierto '+sh.openedAt : ''}${sh.closedAt ? ' · Cerrado '+sh.closedAt : ''}</div>
        </div>
      </div>
      <div class="stats-row-3">
        <div class="shift-stat"><div class="shift-stat-num" style="color:var(--green-text)">${present}</div><div class="shift-stat-label">Presentes</div></div>
        <div class="shift-stat"><div class="shift-stat-num" style="color:var(--amber-text)">${noShows}</div><div class="shift-stat-label">No-shows</div></div>
        <div class="shift-stat"><div class="shift-stat-num">${present + noShows}</div><div class="shift-stat-label">Garantizado</div></div>
      </div>
      ${sh.status === 'closed' ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-sm btn-sm-blue" onclick="exportForzaCSV('${room.id}')">CSV Forza</button>
        <button class="btn-sm btn-sm-green" onclick="exportGovReport('${room.id}','${sh.id}')">Reporte Oficial</button>
      </div>` : ''}`;
    wrap.appendChild(card);
  });

  const allBtn = el('button', 'btn-sm btn-sm-blue', 'CSV Forza completo');
  allBtn.style.cssText = 'width:100%;padding:10px;margin-top:8px';
  allBtn.onclick = () => exportForzaCSV(room.id);
  wrap.appendChild(allBtn);

  return wrap;
}

// Expose to inline onclick
window.exportForzaCSV   = exportForzaCSV;
window.exportGovReport  = exportGovReport;

// ── Room admin UI ─────────────────────────────────────────────
function buildRoomAdmin(room) {
  const wrap = el('div', '');
  if (!state.adminUnlocked) { wrap.appendChild(buildPinGate(() => { state.adminUnlocked = true; rerender(); })); return wrap; }

  const active = Object.values(room?.access || {}).filter(s => s.enabled).length;
  const info = el('div', 'ibar ibar-g');
  info.innerHTML = `<strong>${active} deportes activos</strong> en <strong>${room?.name}</strong>.`;
  wrap.appendChild(info);

  // Room name
  const nameLabel = el('div', 'form-label', 'Nombre del comedor');
  wrap.appendChild(nameLabel);
  const nameRow = el('div', 'mrow', `<input class="minput" id="room-name-input" value="${room?.name || ''}"/><button class="mbtn" id="save-room-name">Guardar</button>`);
  wrap.appendChild(nameRow);

  // Room PIN for operators
  const pinLabel = el('div', 'form-label', 'PIN de operadores (para cambiar a este comedor)');
  wrap.appendChild(pinLabel);
  const pinRow = el('div', 'mrow', `<input class="minput" id="room-pin-input" type="password" maxlength="6" value="${room?.pin || ''}" placeholder="PIN numérico"/><button class="mbtn" id="save-room-pin">Guardar</button>`);
  wrap.appendChild(pinRow);

  // File upload
  const div = el('div', 'sdiv'); wrap.appendChild(div);
  const ulLabel = el('div', 'sl', 'IMPORTAR DATOS');
  wrap.appendChild(ulLabel);
  const ulArea = el('div', 'upload-area', '<div style="font-size:18px;opacity:.5;margin-bottom:4px">📂</div><div>Toca para subir Excel / CSV</div><div style="font-size:11px;margin-top:3px;color:var(--text3)">Fusiona con la config actual</div>');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.xlsx,.xls,.csv'; fileInput.style.display = 'none';
  ulArea.appendChild(fileInput);
  ulArea.onclick = () => fileInput.click();
  wrap.appendChild(ulArea);

  const upMsg = el('div', ''); upMsg.id = 'upload-msg'; wrap.appendChild(upMsg);

  const div2 = el('div', 'sdiv'); wrap.appendChild(div2);
  const sportsLabel = el('div', 'sl', `DEPORTES — ${room?.name}`);
  wrap.appendChild(sportsLabel);

  const addSportRow = el('div', 'mrow', '<input class="minput" id="new-sport-input" placeholder="Nuevo deporte…"/><button class="mbtn" id="add-sport-btn">+ Deporte</button>');
  wrap.appendChild(addSportRow);

  // Sport tree
  Object.entries(room?.access || {}).forEach(([sport, sObj]) => {
    wrap.appendChild(buildSportBlock(room, sport, sObj));
  });

  // Wire events
  setTimeout(() => {
    $('save-room-name')?.addEventListener('click', async () => {
      const v = $('room-name-input')?.value.trim();
      if (v) { await updateDoc(roomDocRef(room.id), { name: v }); }
    });
    $('save-room-pin')?.addEventListener('click', async () => {
      const v = $('room-pin-input')?.value.trim();
      await updateDoc(roomDocRef(room.id), { pin: v });
      alert('PIN guardado.');
    });
    fileInput.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      upMsg.textContent = 'Procesando…'; upMsg.className = 'ibar ibar-b';
      try {
        const buf = await file.arrayBuffer();
        // parseMergeXLSX is defined in the old code — reuse it inline:
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const tree = {};
        rows.slice(1).forEach(row => {
          if (!row[1]) return;
          const cell = String(row[1]);
          if (!cell.includes('\n')) return;
          const parts = cell.split('\n').map(s => s.trim()).filter(Boolean);
          if (parts.length < 4) return;
          const sport = parts[3], state2 = parts[2];
          const cats = parts.slice(4).filter(Boolean);
          if (!tree[sport]) tree[sport] = {};
          if (!tree[sport][state2]) tree[sport][state2] = new Set();
          cats.forEach(c => tree[sport][state2].add(c));
        });
        const newAcc = JSON.parse(JSON.stringify(room.access || {}));
        Object.entries(tree).forEach(([sp, states]) => {
          if (!newAcc[sp]) newAcc[sp] = { enabled: true, states: {} };
          Object.entries(states).forEach(([st, cats]) => {
            if (!newAcc[sp].states[st]) newAcc[sp].states[st] = { enabled: true, cats: {} };
            cats.forEach(c => { if (!newAcc[sp].states[st].cats[c]) newAcc[sp].states[st].cats[c] = { enabled: true }; });
          });
        });
        await updateDoc(roomDocRef(room.id), { access: newAcc });
        upMsg.textContent = `✓ "${file.name}" importado y fusionado.`;
        upMsg.className = 'ibar ibar-g';
      } catch { upMsg.textContent = 'Error al procesar el archivo.'; upMsg.className = 'ibar ibar-r'; }
    };
    $('add-sport-btn')?.addEventListener('click', async () => {
      const v = $('new-sport-input')?.value.trim(); if (!v) return;
      const newAcc = { ...(room.access || {}), [v]: { enabled: true, states: {} } };
      await updateDoc(roomDocRef(room.id), { access: newAcc });
    });
  }, 0);

  return wrap;
}

function buildSportBlock(room, sport, sObj) {
  const block = el('div', 'sb');
  const status = Object.values(sObj.states || {}).every(s => s.enabled && Object.values(s.cats || {}).every(c => c.enabled)) ? 'on' : sObj.enabled ? 'partial' : 'off';
  const hdr = el('div', 'sh');
  hdr.innerHTML = `
    <span class="chev">▼</span>
    <span class="sname">${sport}</span>
    <span class="sbadge ${status === 'on' ? 'bon' : status === 'off' ? 'boff' : 'bpart'}">${status === 'on' ? 'Activo' : status === 'off' ? 'Inactivo' : 'Parcial'}</span>`;

  const sw = buildToggle(sObj.enabled, async val => {
    const newAcc = JSON.parse(JSON.stringify(room.access));
    newAcc[sport].enabled = val;
    Object.values(newAcc[sport].states).forEach(s => { s.enabled = val; Object.values(s.cats).forEach(c => c.enabled = val); });
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  });
  hdr.appendChild(sw);

  const delBtn = el('button', 'del-btn', '✕');
  delBtn.onclick = async e => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar "${sport}"?`)) return;
    const newAcc = JSON.parse(JSON.stringify(room.access));
    delete newAcc[sport];
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  };
  hdr.appendChild(delBtn);

  const body = el('div', 'sbody'); body.style.display = 'none';
  hdr.onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };

  Object.entries(sObj.states || {}).forEach(([state2, stObj]) => {
    body.appendChild(buildStateBlock(room, sport, state2, stObj));
  });

  // Add state row
  const addStRow = el('div', 'add-il-st');
  addStRow.innerHTML = '<input class="add-input" placeholder="Nuevo estado…"/><button class="add-go">+</button>';
  addStRow.querySelector('button').onclick = async () => {
    const v = addStRow.querySelector('input').value.trim(); if (!v) return;
    const newAcc = JSON.parse(JSON.stringify(room.access));
    if (!newAcc[sport].states[v]) newAcc[sport].states[v] = { enabled: true, cats: {} };
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  };
  body.appendChild(addStRow);
  block.appendChild(hdr); block.appendChild(body);
  return block;
}

function buildStateBlock(room, sport, state2, stObj) {
  const block = el('div', 'stblk');
  const hdr = el('div', 'sth');
  hdr.innerHTML = `<span class="chev">▼</span><span class="stname">${state2}</span>`;
  const sw = buildToggle(stObj.enabled, async val => {
    const newAcc = JSON.parse(JSON.stringify(room.access));
    newAcc[sport].states[state2].enabled = val;
    Object.values(newAcc[sport].states[state2].cats).forEach(c => c.enabled = val);
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  }, 'sm');
  hdr.appendChild(sw);
  const delBtn = el('button', 'del-btn', '✕');
  delBtn.onclick = async e => {
    e.stopPropagation();
    if (!confirm(`¿Eliminar "${state2}"?`)) return;
    const newAcc = JSON.parse(JSON.stringify(room.access));
    delete newAcc[sport].states[state2];
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  };
  hdr.appendChild(delBtn);

  const body = el('div', 'stbody'); body.style.display = 'none';
  hdr.onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };

  Object.entries(stObj.cats || {}).forEach(([cat, catObj]) => {
    const row = el('div', 'crow');
    row.innerHTML = `<span class="clabel">${cat}</span>`;
    row.appendChild(buildToggle(catObj.enabled, async val => {
      const newAcc = JSON.parse(JSON.stringify(room.access));
      newAcc[sport].states[state2].cats[cat].enabled = val;
      await updateDoc(roomDocRef(room.id), { access: newAcc });
    }, 'sm'));
    const d = el('button', 'del-btn', '✕');
    d.onclick = async () => {
      if (!confirm(`¿Eliminar "${cat}"?`)) return;
      const newAcc = JSON.parse(JSON.stringify(room.access));
      delete newAcc[sport].states[state2].cats[cat];
      await updateDoc(roomDocRef(room.id), { access: newAcc });
    };
    row.appendChild(d);
    body.appendChild(row);
  });

  const addCatRow = el('div', 'add-il');
  addCatRow.innerHTML = '<input class="add-input" placeholder="Nueva categoría…"/><button class="add-go">+</button>';
  addCatRow.querySelector('button').onclick = async () => {
    const v = addCatRow.querySelector('input').value.trim(); if (!v) return;
    const newAcc = JSON.parse(JSON.stringify(room.access));
    newAcc[sport].states[state2].cats[v] = { enabled: true };
    await updateDoc(roomDocRef(room.id), { access: newAcc });
  };
  body.appendChild(addCatRow);
  block.appendChild(hdr); block.appendChild(body);
  return block;
}

function buildToggle(checked, onChange, size = 'md') {
  const label = el('label', size === 'sm' ? 'sw-sm' : 'sw');
  const input = document.createElement('input');
  input.type = 'checkbox'; input.checked = checked;
  input.onchange = e => { e.stopPropagation(); onChange(input.checked); };
  const span = el('span', size === 'sm' ? 'swss' : 'sws');
  label.onclick = e => e.stopPropagation();
  label.appendChild(input); label.appendChild(span);
  return label;
}

// ── Global admin UI ───────────────────────────────────────────
function buildGlobalAdmin() {
  const wrap = el('div', '');
  if (!state.adminUnlocked) { wrap.appendChild(buildPinGate(() => { state.adminUnlocked = true; rerender(); })); return wrap; }

  // Event name
  const evLabel = el('div', 'sl', 'NOMBRE DEL EVENTO');
  wrap.appendChild(evLabel);
  const evRow = el('div', 'mrow');
  evRow.innerHTML = `<input class="minput" id="event-name-input" value="${state.event?.name || ''}"/><button class="mbtn" id="save-event-name">Guardar</button>`;
  wrap.appendChild(evRow);

  // Stats
  const totalPresent = state.rooms.reduce((s, r) => s + (r.presentToday || 0), 0);
  const stats = el('div', 'stats-row');
  stats.innerHTML = `
    <div class="stat-card"><div class="stat-num">${state.rooms.length}</div><div class="stat-label">Comedores</div></div>
    <div class="stat-card"><div class="stat-num" style="color:var(--green-text)">${totalPresent}</div><div class="stat-label">Accesos hoy (total)</div></div>`;
  wrap.appendChild(stats);

  const div = el('div', 'sdiv'); wrap.appendChild(div);

  // Rooms management
  const rLabel = el('div', 'sl', 'COMEDORES');
  wrap.appendChild(rLabel);
  const rmCard = el('div', 'room-mgmt-card');
  state.rooms.forEach(r => {
    const row = el('div', 'room-mgmt-row');
    row.innerHTML = `
      <span style="flex:1;font-size:13px;font-weight:600">${r.name}</span>
      <button class="btn-sm btn-sm-blue" onclick="exportForzaCSV('${r.id}')">CSV</button>
      <button class="del-btn" onclick="deleteRoom('${r.id}')">✕</button>`;
    rmCard.appendChild(row);
  });
  wrap.appendChild(rmCard);
  const addRoomRow = el('div', 'mrow', '<input class="minput" id="new-room-input" placeholder="Nombre del nuevo comedor…"/><button class="mbtn" id="add-room-btn">+ Comedor</button>');
  wrap.appendChild(addRoomRow);

  const div2 = el('div', 'sdiv'); wrap.appendChild(div2);

  // Admin accounts management
  const admLabel = el('div', 'sl', 'CUENTAS DE ADMINISTRADOR');
  wrap.appendChild(admLabel);
  const admNote = el('div', 'ibar ibar-b', 'Como administrador maestro puedes crear y eliminar cuentas de otros administradores.');
  wrap.appendChild(admNote);

  const addAdminBlock = el('div', 'add-admin-block');
  addAdminBlock.innerHTML = `
    <input class="minput" id="new-admin-email" type="email" placeholder="Email del nuevo admin" style="width:100%;margin-bottom:6px"/>
    <div class="mrow">
      <input class="minput" id="new-admin-pass" type="password" placeholder="Contraseña temporal"/>
      <input class="minput" id="new-admin-name" placeholder="Nombre"/>
    </div>
    <button class="btn-sm btn-sm-blue" id="create-admin-btn" style="width:100%;padding:9px;margin-bottom:6px">Crear cuenta de admin</button>
    <div id="admin-msg"></div>`;
  wrap.appendChild(addAdminBlock);

  // List existing admins
  const adminListWrap = el('div', ''); adminListWrap.id = 'admin-list'; wrap.appendChild(adminListWrap);
  loadAdminList(adminListWrap);

  const div3 = el('div', 'sdiv'); wrap.appendChild(div3);

  // New event
  const evtBox = el('div', 'export-box');
  evtBox.innerHTML = `
    <div style="font-size:13px;font-weight:700;margin-bottom:3px">Exportar y nuevo evento</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:10px">Descarga todos los registros y limpia la configuración.</div>
    <div style="display:flex;gap:8px">
      <button class="btn-sm btn-sm-green" style="flex:1;padding:9px" onclick="exportAllCSV()">Exportar todos (CSV)</button>
      <button class="btn-sm btn-sm-red" style="flex:1;padding:9px" onclick="newEvent()">Nuevo evento</button>
    </div>`;
  wrap.appendChild(evtBox);

  setTimeout(() => {
    $('save-event-name')?.addEventListener('click', async () => {
      const v = $('event-name-input')?.value.trim();
      if (v) await setDoc(eventDocRef(), { name: v }, { merge: true });
    });
    $('add-room-btn')?.addEventListener('click', async () => {
      const v = $('new-room-input')?.value.trim(); if (!v) return;
      const ref = doc(roomsColRef());
      await setDoc(ref, { name: v, access: buildSeedAccess(), pin: '', createdAt: serverTimestamp() });
    });
    $('create-admin-btn')?.addEventListener('click', () => createAdminAccount());
  }, 0);

  return wrap;
}

async function loadAdminList(container) {
  try {
    const snap = await getDocs(usersColRef());
    const admins = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role === 'admin' || u.role === 'master_admin');
    if (admins.length === 0) { container.innerHTML = '<div class="lempty">No hay admins registrados aún.</div>'; return; }
    container.innerHTML = '<div class="sl" style="margin-top:12px">ADMINS EXISTENTES</div>';
    admins.forEach(u => {
      const row = el('div', 'room-mgmt-row');
      row.innerHTML = `
        <div style="flex:1"><div style="font-size:13px;font-weight:600">${u.name || u.email}</div><div style="font-size:11px;color:var(--text2)">${u.email} · ${u.role}</div></div>
        ${u.role !== 'master_admin' ? `<button class="del-btn" onclick="deleteAdmin('${u.uid}')">✕</button>` : '<span style="font-size:10px;color:var(--text3)">Maestro</span>'}`;
      container.appendChild(row);
    });
  } catch (e) { console.error(e); }
}

async function createAdminAccount() {
  const email = $('new-admin-email')?.value.trim();
  const pass  = $('new-admin-pass')?.value.trim();
  const name  = $('new-admin-name')?.value.trim();
  const msg   = $('admin-msg');
  if (!email || !pass) { if (msg) { msg.className = 'ibar ibar-r'; msg.textContent = 'Email y contraseña requeridos.'; } return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await setDoc(userDocRef(cred.user.uid), { email, name: name || email, role: 'admin', createdAt: serverTimestamp() });
    // Sign back in as master admin — user stays logged in because createUser auto-signs in
    // We store the new user profile but we need to re-auth as ourselves
    if (msg) { msg.className = 'ibar ibar-g'; msg.textContent = `✓ Cuenta creada para ${email}. Pide al admin que cambie su contraseña al primer inicio.`; }
  } catch (e) {
    if (msg) { msg.className = 'ibar ibar-r'; msg.textContent = e.message; }
  }
}

window.deleteAdmin = async uid => {
  if (!confirm('¿Eliminar esta cuenta de admin?')) return;
  await deleteDoc(userDocRef(uid));
  rerender();
};

window.deleteRoom = async id => {
  if (state.rooms.length <= 1) { alert('Debe haber al menos un comedor.'); return; }
  if (!confirm('¿Eliminar este comedor y todos sus datos?')) return;
  await deleteDoc(roomDocRef(id));
};

window.exportAllCSV = () => state.rooms.forEach(r => exportForzaCSV(r.id));

window.newEvent = async () => {
  if (!confirm('¿Exportar todos los registros e iniciar un evento nuevo? Esto borrará todos los datos actuales.')) return;
  state.rooms.forEach(r => exportForzaCSV(r.id));
  // Reset rooms and create fresh
  const snap = await getDocs(roomsColRef());
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  const firstRoom = doc(roomsColRef());
  await setDoc(firstRoom, { name: 'Comedor Principal', access: buildSeedAccess(), pin: '', createdAt: serverTimestamp() });
  await setDoc(eventDocRef(), { name: 'Nuevo Evento', createdAt: serverTimestamp() }, { merge: true });
};

function buildSeedAccess() {
  // Minimal seed — gets filled via file upload or manual add
  return {
    "SIN DEPORTE": { enabled: true, states: { "CONADE": { enabled: true, cats: { "SIN CATEGORÍA": { enabled: true }, "SIN PRUEBAS": { enabled: true } } } } },
    "Sin Servicio": { enabled: false, states: { "CONADE": { enabled: false, cats: { "SIN CATEGORÍA": { enabled: false } } } } },
    "Todos": { enabled: true, states: { "CONADE": { enabled: true, cats: { "SIN CATEGORÍA": { enabled: true }, "SIN PRUEBAS": { enabled: true } } } } },
  };
}

// ── PIN gate ──────────────────────────────────────────────────
state.adminUnlocked = false;

function buildPinGate(onSuccess) {
  const wrap = el('div', '');
  const box = el('div', 'pin-wrap');
  box.innerHTML = `<div class="pin-card">
    <div class="pin-t">Administración</div>
    <div class="pin-s">Ingresa tu contraseña de administrador</div>
    <div id="pin-err" class="pin-e" style="display:none">Contraseña incorrecta</div>
    <input class="pin-i" id="pin-input" type="password" placeholder="Contraseña"/>
    <button class="pin-b" id="pin-submit">Ingresar</button>
  </div>`;
  wrap.appendChild(box);
  setTimeout(() => {
    const submit = async () => {
      const pass = $('pin-input')?.value;
      if (!pass) return;
      try {
        const cred = EmailAuthProvider.credential(state.authUser.email, pass);
        await reauthenticateWithCredential(state.authUser, cred);
        onSuccess();
      } catch {
        const errEl = $('pin-err');
        if (errEl) errEl.style.display = 'block';
      }
    };
    $('pin-submit')?.addEventListener('click', submit);
    $('pin-input')?.addEventListener('keydown', e => e.key === 'Enter' && submit());
  }, 0);
  return wrap;
}

// ── Login screen ──────────────────────────────────────────────
function renderLogin() {
  const root = $('root');
  if (!root) return;
  root.innerHTML = `
    <div class="startup">
      <div class="startup-brand">Forza Scans</div>
      <div class="startup-title">Bienvenido</div>
      <div class="startup-sub">Inicia sesión para continuar.</div>
      <div class="login-form">
        <label class="form-label">Correo electrónico</label>
        <input class="minput" id="login-email" type="email" placeholder="tu@correo.com" style="width:100%;margin-bottom:10px"/>
        <label class="form-label">Contraseña</label>
        <input class="minput" id="login-pass" type="password" placeholder="Contraseña" style="width:100%;margin-bottom:16px"/>
        <div id="login-err" class="ibar ibar-r" style="display:none;margin-bottom:10px"></div>
        <button class="startup-go" id="login-btn">Iniciar sesión</button>
      </div>
    </div>`;
  const doLogin = async () => {
    const email = $('login-email')?.value.trim();
    const pass  = $('login-pass')?.value;
    const errEl = $('login-err');
    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (e) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Correo o contraseña incorrectos.'; }
    }
  };
  $('login-btn')?.addEventListener('click', doLogin);
  $('login-pass')?.addEventListener('keydown', e => e.key === 'Enter' && doLogin());
}

// ── First setup (master admin profile creation) ───────────────
function renderFirstSetup() {
  const root = $('root');
  if (!root) return;
  root.innerHTML = `
    <div class="startup">
      <div class="startup-brand">Forza Scans</div>
      <div class="startup-title">Configuración inicial</div>
      <div class="startup-sub">Primera vez que inicias sesión. Completa tu perfil de administrador maestro.</div>
      <label class="form-label" style="align-self:flex-start;margin-top:8px">Tu nombre</label>
      <input class="minput" id="setup-name" placeholder="Nombre completo" style="width:100%;margin-bottom:16px"/>
      <div id="setup-err" class="ibar ibar-r" style="display:none;margin-bottom:10px"></div>
      <button class="startup-go" id="setup-btn">Completar configuración</button>
    </div>`;
  $('setup-btn')?.addEventListener('click', async () => {
    const name = $('setup-name')?.value.trim();
    if (!name) return;
    try {
      await setDoc(userDocRef(state.authUser.uid), {
        email: state.authUser.email, name, role: 'master_admin', createdAt: serverTimestamp(),
      });
      // Create default event + first room
      await setDoc(eventDocRef(), { name: 'Olimpiada Nacional 2026', createdAt: serverTimestamp() }, { merge: true });
      const firstRoom = doc(roomsColRef());
      await setDoc(firstRoom, { name: 'Comedor Principal', access: buildSeedAccess(), pin: '', createdAt: serverTimestamp() });
      state.profile = { role: 'master_admin', name };
      startApp();
    } catch (e) {
      const errEl = $('setup-err');
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = e.message; }
    }
  });
}

// ── Startup mode selector ─────────────────────────────────────
function startApp() {
  geo(); // get location
  const role = state.profile?.role;
  const isAdmin = role === 'master_admin' || role === 'admin';

  // Assign initial room
  state.activeRoomId = state.profile?.assignedRoom || null;

  // Start real-time listeners (room resolved once rooms load)
  startListeners(state.activeRoomId || '_placeholder');

  // Determine view mode
  state.view = 'scanner';
  state.appMode = isAdmin ? 'admin' : 'operator';

  rerender();
}

// ── Once rooms load, ensure activeRoomId is valid ─────────────
const _origRerender = rerender;
function rerender() {
  if (state.rooms.length > 0 && !state.rooms.find(r => r.id === state.activeRoomId)) {
    const assigned = state.profile?.assignedRoom;
    state.activeRoomId = assigned && state.rooms.find(r => r.id === assigned) ? assigned : state.rooms[0].id;
    startListeners(state.activeRoomId);
  }
  _origRerender();
}
