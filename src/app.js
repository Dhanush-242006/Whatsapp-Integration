const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Prevent auth timeout / internal library rejections from crashing Node v24
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled rejection:', reason?.message || reason);
});

const app = express();
const PORT = 3000;
const DATA_DIR   = path.join(__dirname, '../data');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const GROUPS_FILE   = path.join(DATA_DIR, 'groups.json');

const sseClients = new Set();
let botStatus = 'initializing';
let cachedQR  = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readJSON(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}
function writeJSON(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}
function broadcast(event, data) {
  const msg = `data: ${JSON.stringify({ event, data })}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', async (qr) => {
  botStatus = 'qr';
  try {
    cachedQR = await QRCode.toDataURL(qr, { width: 280, margin: 2, color: { dark: '#000', light: '#fff' } });
    broadcast('qr', { image: cachedQR });
    console.log('📱 QR code ready — open http://localhost:' + PORT);
  } catch (err) {
    console.error('QR error:', err.message);
  }
});

client.on('ready', async () => {
  botStatus = 'ready';
  cachedQR  = null;
  console.log('✅ WhatsApp connected!');
  broadcast('ready', {});
  await saveGroups();
});

client.on('auth_failure', () => {
  botStatus = 'auth_failure';
  broadcast('error', { message: 'Authentication failed. Please restart.' });
});

client.on('disconnected', () => {
  botStatus = 'disconnected';
  broadcast('error', { message: 'Disconnected. Please restart.' });
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    const contact  = await msg.getContact();
    const groupId  = chat.id._serialized;
    const number   = contact.number;
    const today    = getTodayKey();
    const activity = readJSON(ACTIVITY_FILE) || {};
    if (!activity[groupId])        activity[groupId] = {};
    if (!activity[groupId][today]) activity[groupId][today] = {};
    activity[groupId][today][number] = {
      name:        contact.pushname || number,
      lastMessage: msg.body.substring(0, 120),
      timestamp:   new Date().toISOString()
    };
    writeJSON(ACTIVITY_FILE, activity);
  } catch {}
});

async function saveGroups() {
  try {
    const chats  = await client.getChats();
    const groups = chats.filter(c => c.isGroup).map(g => ({
      id:           g.id._serialized,
      name:         g.name,
      participants: g.participants.map(p => ({
        number:  p.id.user,
        isAdmin: !!(p.isAdmin || p.isSuperAdmin)
      }))
    }));
    writeJSON(GROUPS_FILE, { groups, updatedAt: new Date().toISOString() });
    console.log(`📋 ${groups.length} groups saved`);
  } catch (err) {
    console.error('saveGroups:', err.message);
  }
}

// ─── Express ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(path.join(__dirname, '../public')));

// Server-Sent Events — real-time QR / ready push
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  // Send current state immediately
  if      (botStatus === 'ready')              res.write(`data: ${JSON.stringify({ event: 'ready', data: {} })}\n\n`);
  else if (botStatus === 'qr' && cachedQR)     res.write(`data: ${JSON.stringify({ event: 'qr', data: { image: cachedQR } })}\n\n`);
  else                                          res.write(`data: ${JSON.stringify({ event: 'status', data: { status: botStatus } })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/logout', async (req, res) => {
  try {
    botStatus = 'initializing';
    cachedQR  = null;
    broadcast('status', { status: 'initializing' });
    await client.logout();
    console.log('👋 Logged out — waiting for new QR...');
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/groups', (req, res) => {
  const data = readJSON(GROUPS_FILE);
  if (!data) return res.json({ groups: [] });
  const activity = readJSON(ACTIVITY_FILE) || {};
  const today    = getTodayKey();
  const groups   = data.groups.map(g => {
    const todayAct   = (activity[g.id] && activity[g.id][today]) ? activity[g.id][today] : {};
    const activeToday = Object.keys(todayAct).length;
    return {
      id:           g.id,
      name:         g.name,
      totalMembers: g.participants.length,
      activeToday,
      inactiveToday: g.participants.length - activeToday
    };
  });
  res.json({ groups });
});

app.get('/api/group/:groupId', (req, res) => {
  const groupId = req.params.groupId;
  const data    = readJSON(GROUPS_FILE);
  if (!data) return res.status(404).json({ error: 'No data' });
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const activity      = readJSON(ACTIVITY_FILE) || {};
  const groupActivity = activity[groupId] || {};
  const today         = getTodayKey();
  const allDays       = Object.keys(groupActivity).sort().reverse();

  // Build members list with last activity
  const members = group.participants.map(p => {
    let lastEntry = null;
    for (const day of allDays) {
      if (groupActivity[day] && groupActivity[day][p.number]) {
        lastEntry = { ...groupActivity[day][p.number], day };
        break;
      }
    }
    return {
      number:      p.number,
      name:        lastEntry ? lastEntry.name        : null,
      lastMessage: lastEntry ? lastEntry.lastMessage : null,
      lastSeen:    lastEntry ? lastEntry.timestamp   : null,
      activeToday: !!(groupActivity[today] && groupActivity[today][p.number]),
      isAdmin:     p.isAdmin
    };
  });

  // Last 7 days stats
  const weekStats = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey    = d.toISOString().split('T')[0];
    const dayName    = d.toLocaleDateString('en-US', { weekday: 'short' });
    const dateLabel  = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
    const dayAct     = groupActivity[dateKey] || {};
    const activeNums = Object.keys(dayAct);
    weekStats.push({
      date:          dateKey,
      day:           dayName,
      label:         `${dayName}\n${dateLabel}`,
      active:        activeNums.length,
      total:         group.participants.length,
      activeMembers: activeNums.map(n => ({
        number:      n,
        name:        dayAct[n].name,
        lastMessage: dayAct[n].lastMessage,
        timestamp:   dayAct[n].timestamp
      }))
    });
  }

  res.json({ id: group.id, name: group.name, totalMembers: group.participants.length, members, weekStats });
});

app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));
console.log('🚀 Starting WhatsApp Monitor...');
client.initialize();
