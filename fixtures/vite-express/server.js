import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const production = process.env.NODE_ENV === 'production';
const testHooks = !production || process.env.TEST_HOOKS === '1';
let failNotes = process.env.FAIL_NOTES === '1';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'",
  });
  next();
});
app.use(express.json());

const notes = [];
const requestLog = [];
const userOf = req => req.get('x-user') || 'anon';

app.use('/api', (req, res, next) => {
  requestLog.push(req.get('x-request-id') || null);
  next();
});

app.post('/api/notes', (req, res) => {
  if (failNotes) return res.status(500).json({ error: 'forced failure' });
  const text = req.body && req.body.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 200) {
    return res.status(400).json({ error: 'text must be 1-200 characters' });
  }
  const note = { id: notes.length + 1, owner: userOf(req), text: text.trim() };
  notes.push(note);
  res.status(201).json(note);
});

app.get('/api/notes', (req, res) => {
  res.json(notes.filter(n => n.owner === userOf(req)));
});

app.get('/api/notes/:id', (req, res) => {
  const note = notes.find(n => n.id === Number(req.params.id));
  if (!note) return res.status(404).json({ error: 'not found' });
  if (note.owner !== userOf(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(note);
});

app.get('/__version', (req, res) => {
  res.json({ sha: process.env.GIT_SHA || 'dev', artifact_sha256: process.env.ARTIFACT_SHA256 });
});

if (testHooks) {
  app.get('/__test/requests', (req, res) => res.json(requestLog));
  app.post('/__test/fail', (req, res) => {
    failNotes = Boolean(req.body && req.body.on);
    res.json({ failNotes });
  });
}

if (production) {
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
  app.use(express.static(dist));
}

app.listen(process.env.PORT || 3000);
