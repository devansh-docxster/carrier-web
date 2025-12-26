const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4010;
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const SQLITE_DB = path.join(DATA_DIR, 'cw1-rates.db');

function loadJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const cw1Rates = loadJson('cw1-rates.json').rates;
const spotRates = loadJson('spot-rates.json').rates;
const teamRates = loadJson('team-rates.json').requests;
const escalationRates = loadJson('escalation-rates.json').requests;
const scenarios = loadJson('scenarios.json').scenarios;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function normalize(value) {
  if (!value) return null;
  return String(value).trim().toUpperCase();
}

function filterRates(rates, query) {
  const origin = normalize(query.origin);
  const destination = normalize(query.destination);
  const mode = normalize(query.mode);
  const equipmentType = normalize(query.equipmentType);
  const serviceLevel = normalize(query.serviceLevel);

  return rates.filter((rate) => {
    if (origin && rate.origin !== origin) return false;
    if (destination && rate.destination !== destination) return false;
    if (mode && rate.mode !== mode) return false;
    if (equipmentType && rate.equipmentType !== equipmentType) return false;
    if (serviceLevel && rate.serviceLevel !== serviceLevel) return false;
    return true;
  });
}

function filterRequests(requests, query) {
  const requestId = normalize(query.requestId);
  const origin = normalize(query.origin);
  const destination = normalize(query.destination);

  return requests.filter((request) => {
    if (requestId && request.requestId !== requestId) return false;
    if (origin && request.origin !== origin) return false;
    if (destination && request.destination !== destination) return false;
    return true;
  });
}

function sanitizeToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 _-]/g, '')
    .trim();
}

function runSqliteQuery(query, res) {
  execFile('sqlite3', ['-json', SQLITE_DB, query], (err, stdout, stderr) => {
    if (err) {
      sendJson(res, 500, { error: 'sqlite_query_failed', details: stderr || err.message });
      return;
    }

    const payload = stdout.trim() ? JSON.parse(stdout) : [];
    sendJson(res, 200, { rates: payload, source: 'sqlite' });
  });
}

function getCookies(req) {
  const header = req.headers.cookie || '';
  const pairs = header.split(';').map((cookie) => cookie.trim()).filter(Boolean);
  const cookies = {};
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    cookies[key] = value || '';
  }
  return cookies;
}

function renderLoginPage(errorMessage) {
  const errorBlock = errorMessage
    ? `<div id="error">${errorMessage}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Carrier Portal - Demo</title>
  <link rel="stylesheet" href="/carrier/style.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Carrier Portal</span>
      <h1>Sign in to view spot rates</h1>
      <p>Demo login required to access the quote search.</p>
      ${errorBlock}
      <form method="POST" action="/carrier/login">
        <label>
          Username
          <input type="text" name="username" placeholder="demo">
        </label>
        <label>
          Password
          <input type="password" name="password" placeholder="demo123">
        </label>
        <button type="submit">Sign in</button>
      </form>
      <p class="hint">Use demo / demo123</p>
    </section>
  </main>
</body>
</html>`;
}

function renderSearchPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Carrier Portal - Search</title>
  <link rel="stylesheet" href="/carrier/style.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Rate Search</span>
      <h1>Get spot rates</h1>
      <p>Search carrier availability by lane and equipment.</p>
      <form method="GET" action="/carrier/results">
        <label>
          Origin
          <input type="text" name="origin" placeholder="LAX" required>
        </label>
        <label>
          Destination
          <input type="text" name="destination" placeholder="SHA" required>
        </label>
        <label>
          Mode
          <select name="mode">
            <option value="OCEAN">OCEAN</option>
            <option value="AIR">AIR</option>
          </select>
        </label>
        <label>
          Equipment Type
          <input type="text" name="equipmentType" placeholder="40HC">
        </label>
        <button type="submit">Search rates</button>
      </form>
      <div class="actions">
        <a href="/carrier/logout">Sign out</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderResultsPage(query, results) {
  const rows = results.map((rate) => {
    return `
      <tr data-rate-row>
        <td>${rate.origin}</td>
        <td>${rate.destination}</td>
        <td>${rate.mode}</td>
        <td>${rate.equipmentType}</td>
        <td>${rate.totalRate}</td>
        <td>${rate.transitDays}</td>
        <td>${rate.carrier}</td>
      </tr>`;
  }).join('');

  const emptyState = results.length === 0
    ? '<div id="no-rates">No rates found for that lane.</div>'
    : `
      <table id="rate-table">
        <thead>
          <tr>
            <th>Origin</th>
            <th>Destination</th>
            <th>Mode</th>
            <th>Equipment</th>
            <th>Total (USD)</th>
            <th>Transit Days</th>
            <th>Carrier</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Carrier Portal - Results</title>
  <link rel="stylesheet" href="/carrier/style.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Results</span>
      <h1>Spot rates</h1>
      <p>Lane: ${query.origin || 'Any'} → ${query.destination || 'Any'}</p>
      ${emptyState}
      <div class="actions">
        <a href="/carrier/search">New search</a>
        <a href="/carrier/logout">Sign out</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (pathname === '/') {
    sendHtml(
      res,
      200,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Docxster Demo Mock Server</title>
  <link rel="stylesheet" href="/carrier/style.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Docxster Demo</span>
      <h1>Mock rates services</h1>
      <p>Use these endpoints in your flows.</p>
      <ul>
        <li><a href="/api/cw1/json">/api/cw1/json</a></li>
        <li><a href="/api/cw1/sqlite">/api/cw1/sqlite</a></li>
        <li><a href="/api/spot">/api/spot</a></li>
        <li><a href="/api/team-rates">/api/team-rates</a></li>
        <li><a href="/api/escalation-rates">/api/escalation-rates</a></li>
        <li><a href="/api/scenarios">/api/scenarios</a></li>
        <li><a href="/carrier/login">Carrier website</a></li>
      </ul>
      <p class="hint">Try /api/cw1/json?origin=LAX&destination=SHA</p>
    </section>
  </main>
</body>
</html>`
    );
    return;
  }

  if (pathname === '/carrier/style.css') {
    const stylePath = path.join(PUBLIC_DIR, 'carrier.css');
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end(fs.readFileSync(stylePath, 'utf8'));
    return;
  }

  if (pathname === '/carrier/login' && req.method === 'GET') {
    sendHtml(res, 200, renderLoginPage(''));
    return;
  }

  if (pathname === '/carrier/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const parsedBody = querystring.parse(body);
    const username = parsedBody.username || '';
    const password = parsedBody.password || '';

    if (username === 'demo' && password === 'demo123') {
      res.writeHead(302, {
        Location: '/carrier/search',
        'Set-Cookie': 'carrier_session=demo; Path=/; HttpOnly'
      });
      res.end();
      return;
    }

    sendHtml(res, 401, renderLoginPage('Invalid credentials.'));
    return;
  }

  if (pathname === '/carrier/logout') {
    res.writeHead(302, {
      Location: '/carrier/login',
      'Set-Cookie': 'carrier_session=; Path=/; Max-Age=0'
    });
    res.end();
    return;
  }

  if (pathname === '/carrier/search') {
    const cookies = getCookies(req);
    if (!cookies.carrier_session) {
      sendRedirect(res, '/carrier/login');
      return;
    }
    sendHtml(res, 200, renderSearchPage());
    return;
  }

  if (pathname === '/carrier/results') {
    const cookies = getCookies(req);
    if (!cookies.carrier_session) {
      sendRedirect(res, '/carrier/login');
      return;
    }
    const results = filterRates(spotRates, parsedUrl.query);
    sendHtml(res, 200, renderResultsPage(parsedUrl.query, results));
    return;
  }

  if (pathname === '/api/cw1/json') {
    const results = filterRates(cw1Rates, parsedUrl.query);
    sendJson(res, 200, { rates: results, source: 'json' });
    return;
  }

  if (pathname === '/api/cw1/sqlite') {
    const origin = sanitizeToken(parsedUrl.query.origin);
    const destination = sanitizeToken(parsedUrl.query.destination);
    const mode = sanitizeToken(parsedUrl.query.mode);
    const equipmentType = sanitizeToken(parsedUrl.query.equipmentType);
    const serviceLevel = sanitizeToken(parsedUrl.query.serviceLevel);

    const filters = [];
    if (origin) filters.push(`origin = '${origin}'`);
    if (destination) filters.push(`destination = '${destination}'`);
    if (mode) filters.push(`mode = '${mode}'`);
    if (equipmentType) filters.push(`equipmentType = '${equipmentType}'`);
    if (serviceLevel) filters.push(`serviceLevel = '${serviceLevel}'`);

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const query = `SELECT * FROM cw1_rates ${whereClause};`;
    runSqliteQuery(query, res);
    return;
  }

  if (pathname === '/api/spot') {
    const results = filterRates(spotRates, parsedUrl.query);
    sendJson(res, 200, { rates: results, source: 'spot' });
    return;
  }

  if (pathname === '/api/team-rates') {
    const results = filterRequests(teamRates, parsedUrl.query);
    sendJson(res, 200, { requests: results, source: 'team' });
    return;
  }

  if (pathname === '/api/escalation-rates') {
    const results = filterRequests(escalationRates, parsedUrl.query);
    sendJson(res, 200, { requests: results, source: 'escalation' });
    return;
  }

  if (pathname === '/api/scenarios') {
    sendJson(res, 200, { scenarios });
    return;
  }

  sendNotFound(res);
});

server.listen(PORT, () => {
  console.log(`Docxster demo mock server running on http://localhost:${PORT}`);
});
