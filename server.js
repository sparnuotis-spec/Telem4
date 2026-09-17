const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT || 5050);
const ROOT = __dirname;
const DATA_DIR = process.env.TELEM4_DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DELETED_BACKUP_DIR = path.join(DATA_DIR, 'deleted-backups');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DELETED_BACKUP_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'telem2.sqlite'));
const transferPresence = new Map();
let droneStatus = { state:'disconnected', port:'', computer:'', operator:'', message:'No flight controller connected', updated_at:0 };
const droneDevices = new Map();
const connectedUsers = new Map();
function lanUrl(){const nets=os.networkInterfaces();for(const entries of Object.values(nets)){for(const net of (entries||[])){if(net.family==='IPv4'&&!net.internal)return `http://${net.address}:${PORT}`;}}return `http://localhost:${PORT}`;}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
for (const column of [
  ['timer_elapsed', 'INTEGER NOT NULL DEFAULT 0'],
  ['timer_started_at', 'TEXT'],
  ['timer_running', 'INTEGER NOT NULL DEFAULT 0']
]) { try { db.exec(`ALTER TABLE sessions ADD COLUMN ${column[0]} ${column[1]}`); } catch (_) {} }
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_no TEXT NOT NULL,
  date TEXT NOT NULL,
  notes TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL CHECK(tag IN ('sd card','regular')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_participants (
  session_id INTEGER NOT NULL,
  pilot_id TEXT NOT NULL,
  PRIMARY KEY(session_id, pilot_id),
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(pilot_id) REFERENCES pilots(pilot_id)
);
CREATE TABLE IF NOT EXISTS uavs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uav_id TEXT NOT NULL UNIQUE,
  drone_type TEXT NOT NULL CHECK(drone_type IN ('sd card','regular')),
  status TEXT NOT NULL DEFAULT 'available',
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  w_group TEXT NOT NULL DEFAULT 'W1',
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'CALM',
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);
CREATE TABLE IF NOT EXISTS flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL,
  round_id INTEGER,
  scenario_id INTEGER,
  pilot_id TEXT,
  uav_id TEXT,
  battery_id TEXT,
  fl TEXT,
  mode TEXT DEFAULT 'CALM',
  weather TEXT DEFAULT 'W1',
  rep TEXT DEFAULT 'REP-01',
  status TEXT NOT NULL DEFAULT 'planned',
  result TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  operator TEXT DEFAULT '',
  claimed_by TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id),
  FOREIGN KEY(round_id) REFERENCES rounds(id),
  FOREIGN KEY(scenario_id) REFERENCES scenarios(id)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(flight_id) REFERENCES flights(flight_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id TEXT,
  event_type TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`);
try { db.exec('ALTER TABLE flights ADD COLUMN sd_transfer_ack INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE events ADD COLUMN session_id INTEGER'); } catch (_) {}
db.prepare("UPDATE flights SET status='completed', result='needs_sd_transfer' WHERE result='sd_transfer_complete'").run();
db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
const existingMaxFlight = db.prepare("SELECT MAX(CAST(SUBSTR(flight_id,4) AS INTEGER)) AS n FROM flights WHERE flight_id LIKE 'FL-%'").get()?.n || 0;
const sequenceStart = Math.max(197, Number(existingMaxFlight) + 1);
db.prepare("INSERT INTO app_settings(key,value) VALUES ('next_flight_number',?) ON CONFLICT(key) DO NOTHING").run(String(sequenceStart));


const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({ dest: UPLOAD_DIR });
const now = () => new Date().toISOString();
const broadcast = () => clients.forEach(res => { try { res.write(`data: ${JSON.stringify({ type: 'refresh', at: now() })}\n\n`); } catch (_) {} });
const clients = new Set();
const uploadLocks = new Set();
const emitEvent = (flightId, type, details = '') => {
  const sessionId = flightId ? db.prepare('SELECT session_id FROM flights WHERE flight_id=?').get(flightId)?.session_id || null : null;
  db.prepare('INSERT INTO events (flight_id,session_id,event_type,details,created_at) VALUES (?,?,?,?,?)').run(flightId || null, sessionId, type, details, now());
  broadcast();
};
const normalizeTag = value => String(value || '').toLowerCase() === 'sd card' ? 'sd card' : 'regular';
const normalizeMode = value => String(value || '').toUpperCase() === 'DYN' ? 'DYN' : 'CALM';
const normalizeWeather = value => String(value || '').toUpperCase() === 'W2' ? 'W2' : 'W1';
const nextFlightId = () => {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='next_flight_number'").get();
  const n = Math.max(197, Number(row?.value) || 197);
  db.prepare("UPDATE app_settings SET value=? WHERE key='next_flight_number'").run(String(n + 1));
  return `FL-${String(n).padStart(6, '0')}`;
};
const autoRepeat = (sessionId, pilotId, scenarioId, mode, weather) => {
  const latest = db.prepare('SELECT * FROM flights WHERE session_id=? AND pilot_id=? AND scenario_id=? AND mode=? AND weather=? ORDER BY id DESC LIMIT 1').get(sessionId, pilotId, scenarioId, mode, weather);
  if (!latest) return 'REP-01';
  const current = Number(String(latest.rep || 'REP-01').replace('REP-', '')) || 1;
  return latest.status === 'completed' || latest.result === 'success' ? `REP-${String(Math.min(current + 1, 4)).padStart(2, '0')}` : `REP-${String(current).padStart(2, '0')}`;
};
const flightName = f => [f.flight_id, f.pilot_id, f.uav_id, f.battery_id, f.scenario_code, f.mode, f.weather, f.rep].filter(Boolean).join('__');

app.get('/api/health', (_, res) => res.json({ ok: true, port: PORT, time: now() }));
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders(); res.write(`data: ${JSON.stringify({ type: 'connected', at: now() })}\n\n`); clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/drone-status',(req,res)=>{const body=req.body||{};const allowed=['disconnected','connecting','verified','mass_storage','error'];const status=String(body.state||'').toLowerCase();if(!allowed.includes(status))return res.status(400).json({error:'Invalid drone status.'});const explicitOperator=String(body.operator||'').trim();const latestOperator=[...connectedUsers.values()].sort((a,b)=>b.updated_at-a.updated_at)[0]?.name||'';const operatorKey=(explicitOperator||latestOperator).trim();const connectionId=operatorKey||String(body.connection_id||'').slice(0,100)||`${Date.now()}-${Math.random().toString(36).slice(2)}`;droneStatus={state:status,connection_id:connectionId,port:String(body.port||'').slice(0,20),computer:String(body.computer||'').slice(0,80),operator:(explicitOperator||latestOperator).slice(0,80),message:String(body.message||status).slice(0,160),updated_at:Date.now()};droneDevices.set(connectionId,droneStatus);broadcast();res.json({ok:true});});
app.post('/api/user-presence',(req,res)=>{const body=req.body||{};const clientId=String(body.client_id||'').slice(0,80);if(!clientId)return res.status(400).json({error:'Client is required.'});connectedUsers.set(clientId,{client_id:clientId,name:String(body.name||'Admin').slice(0,60),updated_at:Date.now()});broadcast();res.json({ok:true});});
app.post('/api/transfer-presence', (req,res)=>{ const body=req.body||{}; const flightId=Number(body.flight_id); const admin=String(body.admin||'Admin').slice(0,60); const clientId=String(body.client_id||'').slice(0,80); const batchKey=String(body.batch_key||flightId); if(!flightId)return res.status(400).json({error:'Flight is required.'}); const nowMs=Date.now(); for(const [key,value] of transferPresence) if(nowMs-value.updated_at>30000) transferPresence.delete(key); if(body.action==='open'){const conflict=[...transferPresence.values()].find(v=>v.batch_key===batchKey&&v.updated_at>nowMs-30000&&v.client_id!==clientId);if(conflict)return res.status(409).json({error:`Transfer is already open by ${conflict.admin}.`});} const key=String(flightId); if(body.action==='close') transferPresence.delete(key); else transferPresence.set(key,{admin,client_id:clientId,batch_key:batchKey,mode:body.action==='uploading'?'uploading':'open',updated_at:nowMs}); broadcast(); res.json({ok:true}); });
app.get('/api/state', (req, res) => {
  const requestedSessionId = Number(req.query.session_id || 0);
  const session = requestedSessionId ? (db.prepare('SELECT * FROM sessions WHERE id=?').get(requestedSessionId) || null) : null;
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY date DESC, id DESC').all();
  const pilots = db.prepare('SELECT * FROM pilots ORDER BY pilot_id').all();
  const uavs = db.prepare('SELECT * FROM uavs ORDER BY uav_id').all();
  const rounds = db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY position, id').all(session?.id || -1);
  const scenarios = db.prepare('SELECT * FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id = ?) ORDER BY position, id').all(session?.id || -1);
  const flights = db.prepare(`SELECT f.*, r.name round_name, s.code scenario_code, s.name scenario_name, p.name pilot_name, p.tag pilot_tag
    FROM flights f LEFT JOIN rounds r ON r.id=f.round_id LEFT JOIN scenarios s ON s.id=f.scenario_id LEFT JOIN pilots p ON p.pilot_id=f.pilot_id
    WHERE f.session_id = ? ORDER BY f.id`).all(session?.id || -1);
  const files = db.prepare('SELECT * FROM files ORDER BY id DESC').all();
  const events = session ? db.prepare(`SELECT e.*,COALESCE(e.session_id,f.session_id) AS event_session_id,COALESCE(e.flight_id,'') AS event_flight_id FROM events e LEFT JOIN flights f ON f.flight_id=e.flight_id WHERE e.session_id=? OR f.session_id=? ORDER BY e.id DESC LIMIT 500`).all(session.id,session.id) : [];
  const participants = session ? db.prepare('SELECT pilot_id FROM session_participants WHERE session_id=? ORDER BY pilot_id').all(session.id).map(x=>x.pilot_id) : [];
  for (const [key,value] of transferPresence) if (Date.now()-value.updated_at>30000) transferPresence.delete(key); for (const [key,value] of connectedUsers) if (Date.now()-value.updated_at>15000) connectedUsers.delete(key);
  res.json({ session, sessions, participants, pilots, uavs, rounds, scenarios, flights: flights.map(f => ({ ...f, display_name: flightName(f) })), files, events, transfer_presence:Object.fromEntries(transferPresence), connected_users:[...connectedUsers.values()], drone_status:droneStatus, drone_devices:[...droneDevices.values()], lan_url:lanUrl() });
});

app.post('/api/session', (req, res) => {
  const body = req.body || {}; if (!body.session_no || !body.date) return res.status(400).json({ error: 'Session number and date are required.' });
  const t = now(); const tx = db.transaction(() => {
    db.prepare("UPDATE sessions SET status='closed', updated_at=? WHERE status='active'").run(t);
    const result = db.prepare('INSERT INTO sessions(session_no,date,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(String(body.session_no), body.date, body.notes || '', 'active', t, t);
    return result.lastInsertRowid;
  });
  const id = tx(); emitEvent(null, 'session_created', `Session ${body.session_no}`); res.json({ id });
});
app.put('/api/session/:id/participants', (req, res) => {
  const sessionId=Number(req.params.id); const ids=[...new Set((req.body?.pilot_ids||[]).map(String))]; const valid=ids.filter(id=>db.prepare('SELECT 1 FROM pilots WHERE pilot_id=?').get(id));
  const tx=db.transaction(()=>{db.prepare('DELETE FROM session_participants WHERE session_id=?').run(sessionId); const add=db.prepare('INSERT INTO session_participants(session_id,pilot_id) VALUES (?,?)'); valid.forEach(id=>add.run(sessionId,id));}); tx(); broadcast(); res.json({ok:true,participants:valid});
});
app.patch('/api/session/:id', (req, res) => {
  const body = req.body || {}; const t = now(); const id = Number(req.params.id); const current = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!current) return res.status(404).json({error:'Session not found.'});
  if (body.timer_action === 'start') db.prepare('UPDATE sessions SET timer_running=1,timer_started_at=COALESCE(timer_started_at,?),updated_at=? WHERE id=?').run(t,t,id);
  else if (body.timer_action === 'stop') { const elapsed=Number(current.timer_elapsed||0)+(current.timer_running&&current.timer_started_at?Math.max(0,Date.now()-Date.parse(current.timer_started_at)):0); db.prepare('UPDATE sessions SET timer_elapsed=?,timer_started_at=NULL,timer_running=0,updated_at=? WHERE id=?').run(elapsed,t,id); }
  else if (body.timer_action === 'reset') db.prepare('UPDATE sessions SET timer_elapsed=0,timer_started_at=NULL,timer_running=0,updated_at=? WHERE id=?').run(t,id);
  else db.prepare('UPDATE sessions SET notes=COALESCE(?,notes), status=COALESCE(?,status), updated_at=? WHERE id=?').run(body.notes, body.status, t, id);
  emitEvent(null, 'session_updated'); res.json({ ok: true });
});
app.delete('/api/session/:id', (req, res) => {
  const id = Number(req.params.id); const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(id); if (!session) return res.status(404).json({ error: 'Session not found.' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'); const backupDir = path.join(DELETED_BACKUP_DIR, `${stamp}-session-${session.session_no.replace(/[^a-zA-Z0-9_-]/g, '_')}`); fs.mkdirSync(path.join(backupDir, 'files'), { recursive: true });
  const rounds = db.prepare('SELECT * FROM rounds WHERE session_id=?').all(id); const scenarios = db.prepare('SELECT * FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id=?)').all(id); const flights = db.prepare('SELECT * FROM flights WHERE session_id=?').all(id); const files = db.prepare('SELECT * FROM files WHERE flight_id IN (SELECT flight_id FROM flights WHERE session_id=?)').all(id);
  for (const file of files) if (fs.existsSync(file.stored_path)) fs.copyFileSync(file.stored_path, path.join(backupDir, 'files', file.original_name.replace(/[^a-zA-Z0-9._-]/g, '_')));
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({ session, rounds, scenarios, flights, files, backed_up_at: now() }, null, 2));
  const tx = db.transaction(() => {
    flights.forEach(f => { db.prepare('DELETE FROM files WHERE flight_id=?').run(f.flight_id); db.prepare('DELETE FROM events WHERE flight_id=?').run(f.flight_id); });
    db.prepare('DELETE FROM flights WHERE session_id=?').run(id); db.prepare('DELETE FROM scenarios WHERE round_id IN (SELECT id FROM rounds WHERE session_id=?)').run(id); db.prepare('DELETE FROM rounds WHERE session_id=?').run(id); db.prepare('DELETE FROM session_participants WHERE session_id=?').run(id); db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    flights.forEach(f => fs.rmSync(path.join(UPLOAD_DIR, f.flight_id), { recursive: true, force: true }));
  });
  tx(); emitEvent(null, 'session_deleted', `Session ${session.session_no}`); res.json({ ok: true, backup_dir: backupDir });
});

app.post('/api/pilots', (req, res) => {
  const pilot_id = String(req.body?.pilot_id || '').trim().toUpperCase();
  const name = String(req.body?.name || '').trim();
  const tag = String(req.body?.tag || '').trim().toLowerCase();
  if (!pilot_id || !name || !['sd card','regular'].includes(tag)) return res.status(400).json({ error: 'Pilot ID, name, and tag are required.' });
  const existing = db.prepare('SELECT * FROM pilots WHERE pilot_id=?').get(pilot_id);
  if (existing && existing.name !== name) return res.status(409).json({ error: 'Pilot IDs are immutable and already belong to another name.' });
  const t = now();
  if (existing) db.prepare('UPDATE pilots SET name=?,tag=?,active=1,updated_at=? WHERE pilot_id=?').run(name, tag, t, pilot_id);
  else db.prepare('INSERT INTO pilots(pilot_id,name,tag,created_at,updated_at) VALUES (?,?,?,?,?)').run(pilot_id, name, tag, t, t);
  broadcast(); res.json({ ok: true, pilot: { pilot_id, name, tag, active: 1 } });
});
app.post('/api/uavs', (req, res) => {
  const { uav_id, drone_type, notes } = req.body || {}; if (!uav_id || !['sd card','regular'].includes(drone_type)) return res.status(400).json({ error: 'UAV ID and drone type are required.' });
  db.prepare('INSERT INTO uavs(uav_id,drone_type,notes) VALUES (?,?,?) ON CONFLICT(uav_id) DO UPDATE SET drone_type=excluded.drone_type,notes=excluded.notes').run(uav_id, drone_type, notes || ''); broadcast(); res.json({ ok: true });
});

app.post('/api/rounds', (req, res) => {
  const body = req.body || {}; const session = body.session_id ? db.prepare('SELECT id FROM sessions WHERE id=?').get(body.session_id) : db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1").get(); if (!session) return res.status(400).json({ error: 'Create or select a session first.' });
  const result = db.prepare('INSERT INTO rounds(session_id,name,w_group,position,status) VALUES (?,?,?,?,?)').run(session.id, body.name || 'Round', normalizeWeather(body.w_group), Number(body.position || 0), 'planned'); broadcast(); res.json({ id: result.lastInsertRowid });
});
app.post('/api/scenarios', (req, res) => {
  const body = req.body || {}; if (!body.name) return res.status(400).json({ error: 'Scenario is required.' });
  let roundId = body.round_id; if (!roundId && body.session_id) { const existing = db.prepare('SELECT id FROM rounds WHERE session_id=? ORDER BY id LIMIT 1').get(body.session_id); if (existing) roundId = existing.id; else { const created = db.prepare(`INSERT INTO rounds(session_id,name,w_group,position,status) VALUES (?,?,?,?,?)`).run(body.session_id, 'Default', 'W1', 0, 'planned'); roundId = created.lastInsertRowid; } }
  if (!roundId) return res.status(400).json({ error: 'Select a session first.' }); const codes = {'Linijinis skrydis A–B–A':'SC-01','Kvadratas':'SC-02','Ovalas':'SC-03','Freestyle / trys laiptai':'SC-04','Slalomas':'SC-05','Aštuoniukė':'SC-06'}; const code = body.code || codes[body.name] || 'SC-CUSTOM';
  const result = db.prepare('INSERT INTO scenarios(round_id,code,name,mode,position) VALUES (?,?,?,?,?)').run(roundId, code, body.name, 'CALM', Number(body.position || 0)); broadcast(); res.json({ id: result.lastInsertRowid });
});
app.post('/api/flights', (req, res) => {
  const body = req.body || {}; const session = body.session_id ? db.prepare('SELECT id FROM sessions WHERE id=?').get(body.session_id) : db.prepare("SELECT id FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1").get(); if (!session) return res.status(400).json({ error: 'Create or select a session first.' });
  if (!body.scenario_id) return res.status(400).json({ error: 'Scenario is required.' });
  const scenario = db.prepare('SELECT s.*, r.w_group FROM scenarios s JOIN rounds r ON r.id=s.round_id WHERE s.id=?').get(body.scenario_id); if (!scenario) return res.status(400).json({ error: 'Scenario not found.' });
  const pilotIds=[...new Set(body.pilot_ids|| (body.pilot_id?[body.pilot_id]:[]))].filter(id=>db.prepare('SELECT 1 FROM session_participants WHERE session_id=? AND pilot_id=?').get(session.id,id)); if (!pilotIds.length) return res.status(400).json({ error: 'Select at least one participating pilot in Planning.' });
  const created=[]; const insert=db.prepare(`INSERT INTO flights(flight_id,session_id,round_id,scenario_id,pilot_id,uav_id,battery_id,fl,mode,weather,rep,status,notes,operator,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx=db.transaction(()=>{pilotIds.forEach(pilotId=>{const uavId=`UAV-${String(pilotId).replace(/^PILOT-/,'')}`; for(const mode of ['CALM','DYN'])for(let i=1;i<=4;i++){const rep=`REP-${String(i).padStart(2,'0')}`;const result=insert.run(`PENDING-${crypto.randomUUID()}`,session.id,scenario.round_id,body.scenario_id,pilotId,uavId,'','',mode,normalizeWeather(scenario.w_group),rep,'planned',body.notes||'',body.operator||'',now(),now());created.push(result.lastInsertRowid);}})}); tx(); emitEvent(null,'flight_series_created',`${created.length} pending flights`); res.json({ids:created,count:created.length});
});
app.patch('/api/flights/:id', (req, res) => {
  const allowed = ['pilot_id','uav_id','battery_id','fl','mode','weather','rep','status','result','notes','operator','claimed_by','round_id','scenario_id','sd_transfer_ack'];
  const body = req.body || {}; const flight = db.prepare('SELECT * FROM flights WHERE id=?').get(req.params.id); if (!flight) return res.status(404).json({ error: 'Flight not found.' });
  if (['ready','flying','transfer','completed'].includes(body.status) || body.result === 'success') { const repNo=Number(String(flight.rep||'REP-01').replace('REP-',''))||1; if (flight.mode==='DYN') { const calmDone=db.prepare("SELECT COUNT(*) AS n FROM flights WHERE session_id=? AND pilot_id=? AND scenario_id=? AND mode='CALM' AND status='completed' AND result IN ('success','needs_sd_transfer')").get(flight.session_id,flight.pilot_id,flight.scenario_id).n; if (calmDone < 4) return res.status(400).json({ error: 'Complete all four CALM repetitions for this scenario before starting DYN.' }); } if (repNo>1) { const previous=db.prepare('SELECT status,result FROM flights WHERE session_id=? AND pilot_id=? AND scenario_id=? AND mode=? AND rep=?').get(flight.session_id,flight.pilot_id,flight.scenario_id,flight.mode,`REP-${String(repNo-1).padStart(2,'0')}`); if (!previous || previous.status!=='completed' || !['success','needs_sd_transfer'].includes(previous.result)) return res.status(400).json({ error: `Complete ${flight.mode} REP-${String(repNo-1).padStart(2,'0')} before advancing.` }); } }
  if (body.status === 'completed' && !String(body.battery_id || flight.battery_id || '').trim()) return res.status(400).json({ error: 'Enter the battery number before completing this flight.' });
  if ((body.status === 'completed' || body.result === 'success')) { const kinds = db.prepare('SELECT DISTINCT kind FROM files WHERE flight_id=?').all(flight.flight_id).map(x => x.kind); if (!kinds.includes('telemetry') || !kinds.includes('goggles')) { const pilot=db.prepare('SELECT tag FROM pilots WHERE pilot_id=?').get(flight.pilot_id); if (!pilot || !['sd card','regular'].includes(pilot.tag)) return res.status(400).json({ error: 'Upload both telemetry and goggles video before marking success.' }); body.result='needs_sd_transfer'; } }
  const updates = []; const values = []; for (const key of allowed) if (body[key] !== undefined) { updates.push(`${key}=?`); values.push(key === 'mode' ? normalizeMode(body[key]) : key === 'weather' ? normalizeWeather(body[key]) : body[key]); }
  if (!updates.length) return res.json({ ok: true }); updates.push('updated_at=?'); values.push(now(), req.params.id);
  db.prepare(`UPDATE flights SET ${updates.join(',')} WHERE id=?`).run(...values); emitEvent(flight.flight_id, 'flight_updated', JSON.stringify(body)); res.json({ ok: true });
});

app.delete('/api/flights/:id', (req, res) => {
  const id = Number(req.params.id); const flight = db.prepare('SELECT * FROM flights WHERE id=?').get(id); if (!flight) return res.status(404).json({ error: 'Flight not found.' });
  const files = db.prepare('SELECT stored_path FROM files WHERE flight_id=?').all(flight.flight_id); files.forEach(f => fs.rmSync(f.stored_path, { force: true }));
  emitEvent(flight.flight_id, 'flight_deleted', JSON.stringify({flight_id:flight.flight_id,pilot_id:flight.pilot_id,scenario_id:flight.scenario_id})); db.prepare('UPDATE events SET session_id=? WHERE flight_id=?').run(flight.session_id,flight.flight_id);
  db.prepare('DELETE FROM files WHERE flight_id=?').run(flight.flight_id); db.prepare('DELETE FROM flights WHERE id=?').run(id);
  fs.rmSync(path.join(UPLOAD_DIR, flight.flight_id), { recursive: true, force: true }); broadcast(); res.json({ ok: true });
});
app.post('/api/sd-transfer/:pilot/confirm', (req, res) => {
  const pilotId=req.params.pilot; const sessionId=Number(req.body?.session_id||0); const mode=String(req.body?.mode||'CALM').toUpperCase()==='DYN'?'DYN':'CALM'; const pilot=db.prepare('SELECT tag FROM pilots WHERE pilot_id=?').get(pilotId); const batchSize=pilot?.tag==='sd card'?4:4; const flights=db.prepare("SELECT * FROM flights WHERE session_id=? AND pilot_id=? AND mode=? AND status='completed' AND sd_transfer_ack=0 AND result IN ('success','needs_sd_transfer') ORDER BY id").all(sessionId,pilotId,mode); if(flights.length!==batchSize)return res.status(400).json({error:`Exactly ${batchSize} completed flights are required.`});
  for(const f of flights){const kinds=db.prepare('SELECT DISTINCT kind FROM files WHERE flight_id=?').all(f.flight_id).map(x=>x.kind);if(!kinds.includes('telemetry')||!kinds.includes('goggles'))return res.status(400).json({error:'Upload all eight files before confirming.'});}
  const assigned=[];const tx=db.transaction(()=>{for(const f of flights){const id=nextFlightId();const result=db.prepare(`INSERT INTO flights(flight_id,session_id,round_id,scenario_id,pilot_id,uav_id,battery_id,fl,mode,weather,rep,status,result,notes,operator,claimed_by,sd_transfer_ack,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,f.session_id,f.round_id,f.scenario_id,f.pilot_id,f.uav_id,f.battery_id,f.fl,f.mode,f.weather,f.rep,f.status,f.result,f.notes,f.operator,f.claimed_by,1,f.created_at,now());const files=db.prepare('SELECT * FROM files WHERE flight_id=?').all(f.flight_id);for(const file of files){const ext=path.extname(file.original_name).toLowerCase();const session=db.prepare('SELECT session_no FROM sessions WHERE id=?').get(f.session_id);const folder=String(session?.session_no||f.session_id).replace(/[^a-zA-Z0-9_-]/g,'_');const finalPath=path.join(UPLOAD_DIR,folder,file.kind==='goggles'?'goggles':'blackbox',`${id}${ext}`);fs.mkdirSync(path.dirname(finalPath),{recursive:true});if(fs.existsSync(file.stored_path))fs.renameSync(file.stored_path,finalPath);db.prepare('UPDATE files SET flight_id=?,stored_path=? WHERE id=?').run(id,finalPath,file.id);}db.prepare('UPDATE events SET flight_id=? WHERE flight_id=?').run(id,f.flight_id);db.prepare('DELETE FROM flights WHERE id=?').run(f.id);assigned.push(id);}});tx();broadcast();res.json({ok:true,flight_ids:assigned});
});
app.post('/api/flights/:id/files', upload.array('files'), async (req, res) => {
  const flight = db.prepare('SELECT * FROM flights WHERE id=?').get(req.params.id); if (!flight) return res.status(404).json({ error: 'Flight not found.' });
  const requestedKind = req.body.kind || 'telemetry'; const kind = requestedKind === 'goggles' ? 'goggles' : 'telemetry'; const lockKey = `${flight.flight_id}:${kind}`; if (uploadLocks.has(lockKey) || db.prepare('SELECT 1 FROM files WHERE flight_id=? AND kind=? LIMIT 1').get(flight.flight_id, kind)) { (req.files||[]).forEach(file=>fs.rmSync(file.path,{force:true})); return res.status(409).json({ error: 'This upload slot is already occupied or uploading.' }); } uploadLocks.add(lockKey); try { const folderName = kind === 'goggles' ? 'goggles' : 'blackbox'; const session=db.prepare('SELECT session_no FROM sessions WHERE id=?').get(flight.session_id); const sessionFolder=String(session?.session_no||flight.session_id).replace(/[^a-zA-Z0-9_-]/g,'_'); const destination = path.join(UPLOAD_DIR, sessionFolder, folderName); fs.mkdirSync(destination, { recursive: true });
  const saved = [];
  for (const file of req.files || []) {
    const finalPath = path.join(destination, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`); fs.renameSync(file.path, finalPath);
    const hash = crypto.createHash('sha256').update(await fs.promises.readFile(finalPath)).digest('hex');
    const r = db.prepare('INSERT INTO files(flight_id,kind,original_name,stored_path,size,sha256,created_at) VALUES (?,?,?,?,?,?,?)').run(flight.flight_id, kind, file.originalname, finalPath, file.size, hash, now()); saved.push({ id: r.lastInsertRowid, original_name: file.originalname, size: file.size, sha256: hash });
  }
  let assignedFlightId = flight.flight_id; let assignedFlightDbId = flight.id; const kinds = db.prepare('SELECT DISTINCT kind FROM files WHERE flight_id=?').all(flight.flight_id).map(x => x.kind);
  if (flight.flight_id.startsWith('PENDING-') && kinds.includes('telemetry') && kinds.includes('goggles') && req.body.sd_batch !== '1') {
    assignedFlightId = nextFlightId(); const oldRoot = path.join(UPLOAD_DIR, flight.flight_id); const newRoot = path.join(UPLOAD_DIR, assignedFlightId);
    const migrate = db.transaction(() => {
      const result = db.prepare(`INSERT INTO flights(flight_id,session_id,round_id,scenario_id,pilot_id,uav_id,battery_id,fl,mode,weather,rep,status,result,notes,operator,claimed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(assignedFlightId, flight.session_id, flight.round_id, flight.scenario_id, flight.pilot_id, flight.uav_id, flight.battery_id, flight.fl, flight.mode, flight.weather, flight.rep, flight.status, flight.result, flight.notes, flight.operator, flight.claimed_by, flight.created_at, now());
      assignedFlightDbId = result.lastInsertRowid; db.prepare('UPDATE files SET flight_id=? WHERE flight_id=?').run(assignedFlightId, flight.flight_id); db.prepare('UPDATE events SET flight_id=? WHERE flight_id=?').run(assignedFlightId, flight.flight_id); db.prepare('DELETE FROM flights WHERE id=?').run(flight.id);
    });
    migrate();
    const stem = assignedFlightId;
    const completedFiles = db.prepare('SELECT * FROM files WHERE flight_id=?').all(assignedFlightId);
    for (const stored of completedFiles) { const folder = stored.kind === 'goggles' ? 'goggles' : 'blackbox'; const ext = path.extname(stored.original_name).toLowerCase(); const sess = db.prepare('SELECT session_no FROM sessions WHERE id=(SELECT session_id FROM flights WHERE id=?)').get(assignedFlightDbId); const sessionFolder = String(sess?.session_no||flight.session_id).replace(/[^a-zA-Z0-9_-]/g,'_'); const finalPath = path.join(UPLOAD_DIR, sessionFolder, folder, `${stem}${ext}`); fs.mkdirSync(path.dirname(finalPath), { recursive: true }); if (fs.existsSync(stored.stored_path)) fs.renameSync(stored.stored_path, finalPath); db.prepare('UPDATE files SET stored_path=? WHERE id=?').run(finalPath, stored.id); }
    fs.rmSync(oldRoot, { recursive: true, force: true });
  }
  emitEvent(assignedFlightId, 'files_uploaded', `${saved.length} ${kind} file(s)`); res.json({ files: saved, flight_id: assignedFlightId, flight_db_id: assignedFlightDbId, assigned: assignedFlightId !== flight.flight_id }); } catch (err) { (req.files||[]).forEach(file=>fs.rmSync(file.path,{force:true})); res.status(500).json({ error: err.message || 'Upload failed.' }); } finally { uploadLocks.delete(lockKey); }
});
app.get('/api/files/:id', (req, res) => { const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id); if (!f || !fs.existsSync(f.stored_path)) return res.status(404).end(); res.download(f.stored_path, f.original_name); });

function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportCsv() {
  const rows = db.prepare(`SELECT f.flight_id, f.pilot_id, p.name pilot_name, f.uav_id, f.battery_id, f.scenario_id, s.code scenario_code, f.mode, f.weather, f.rep, CASE WHEN f.result <> '' THEN f.result WHEN f.status='completed' THEN 'success' WHEN f.status='failed' THEN 'failed' ELSE f.status END AS result, f.notes, f.created_at, f.updated_at
    FROM flights f LEFT JOIN pilots p ON p.pilot_id=f.pilot_id LEFT JOIN scenarios s ON s.id=f.scenario_id ORDER BY CASE WHEN f.flight_id LIKE 'PENDING-%' THEN 1 ELSE 0 END, CASE WHEN f.flight_id LIKE 'FL-%' THEN CAST(SUBSTR(f.flight_id,4) AS INTEGER) ELSE 2147483647 END, f.id`).all();
  const headers = Object.keys(rows[0] || { flight_id:'', pilot_id:'', pilot_name:'', uav_id:'', battery_id:'', scenario_code:'', mode:'', weather:'', rep:'', result:'', notes:'', created_at:'', updated_at:'' });
  return [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
}
app.get('/api/export.csv', (_, res) => { res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename=telem4-flights.csv'); res.send(exportCsv()); });
app.post('/api/sync', (req, res) => {
  const exportPath = path.join(DATA_DIR, `telem4-flights-${new Date().toISOString().slice(0,10)}.csv`); fs.writeFileSync(exportPath, exportCsv());
  const folder = process.env.GOOGLE_DRIVE_FOLDER_ID || '';
  if (!folder) return res.json({ ok: true, local_export: exportPath, message: 'Local export created. Set GOOGLE_DRIVE_FOLDER_ID to upload snapshots to Drive.' });
  const json = JSON.stringify({ name: path.basename(exportPath), parents: [folder] });
  execFile('gws', ['drive','files','create','--upload',exportPath,'--json',json,'--upload-content-type','text/csv'], { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) return res.status(502).json({ ok: false, local_export: exportPath, error: stderr || error.message });
    res.json({ ok: true, local_export: exportPath, drive: stdout });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Telem4 listening on http://0.0.0.0:${PORT}`));
