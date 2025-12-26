const functions = require('firebase-functions');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const DATA_DIR = path.join(__dirname, 'data');

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
  res.status(statusCode).json(payload);
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
  <link rel="stylesheet" href="/carrier.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Carrier Portal</span>
      <h1>Sign in to view spot rates</h1>
      <p>Demo login required to access the quote search.</p>
      ${errorBlock}
      <form method="POST" action="/api/carrier/login">
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

function renderSearchPage(sessionToken) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Carrier Portal - Search</title>
  <link rel="stylesheet" href="/carrier.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Rate Search</span>
      <h1>Get spot rates</h1>
      <p>Search carrier availability by lane and equipment.</p>
      <form method="GET" action="/api/carrier/results">
        <input type="hidden" name="session" value="${sessionToken || 'demo'}">
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
        <a href="/api/carrier/logout">Sign out</a>
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
  <link rel="stylesheet" href="/carrier.css">
</head>
<body>
  <main>
    <section class="card">
      <span class="badge">Results</span>
      <h1>Spot rates</h1>
      <p>Lane: ${query.origin || 'Any'} → ${query.destination || 'Any'}</p>
      ${emptyState}
      <div class="actions">
        <a href="/api/carrier/search">New search</a>
        <a href="/api/carrier/logout">Sign out</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

// Main API handler
exports.api = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).send('');
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;
  
  // Remove /api prefix if present (Firebase routing adds it)
  if (pathname.startsWith('/api')) {
    pathname = pathname.substring(4);
  }
  
  // Ensure pathname starts with /
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }
  
  // Parse POST body if needed
  let bodyData = '';
  if (req.method === 'POST') {
    // Check if body is already parsed or available as rawBody
    if (req.rawBody) {
      bodyData = req.rawBody.toString();
    } else if (req.body && typeof req.body === 'object') {
      // Body already parsed as JSON
      bodyData = '';
    } else {
      try {
        bodyData = await new Promise((resolve, reject) => {
          let data = '';
          const timeout = setTimeout(() => {
            console.log('Body parse timeout, using empty string');
            resolve('');
          }, 5000);
          
          req.on('data', (chunk) => {
            data += chunk.toString();
          });
          
          req.on('end', () => {
            clearTimeout(timeout);
            resolve(data);
          });
          
          req.on('error', (err) => {
            clearTimeout(timeout);
            console.error('Body parsing error:', err);
            resolve('');
          });
        });
      } catch (err) {
        console.error('Body parsing error:', err);
        bodyData = '';
      }
    }
  }
  
  console.log('Original path:', req.url, 'Normalized path:', pathname);

  // API Routes
  if (pathname === '/cw1/json') {
    const results = filterRates(cw1Rates, parsedUrl.query);
    res.json({ rates: results, source: 'json' });
    return;
  }

  if (pathname === '/spot') {
    const results = filterRates(spotRates, parsedUrl.query);
    res.json({ rates: results, source: 'spot' });
    return;
  }

  if (pathname === '/team-rates') {
    const results = filterRequests(teamRates, parsedUrl.query);
    res.json({ requests: results, source: 'team' });
    return;
  }

  if (pathname === '/escalation-rates') {
    const results = filterRequests(escalationRates, parsedUrl.query);
    res.json({ requests: results, source: 'escalation' });
    return;
  }

  if (pathname === '/scenarios') {
    res.json({ scenarios });
    return;
  }

  // Carrier Portal Routes
  if (pathname === '/carrier/login' && req.method === 'GET') {
    res.send(renderLoginPage(''));
    return;
  }

  if (pathname === '/carrier/login' && req.method === 'POST') {
    console.log('POST body data:', bodyData);
    console.log('Body length:', bodyData.length);
    console.log('req.rawBody:', req.rawBody);
    console.log('req.body:', req.body);
    
    const parsedBody = querystring.parse(bodyData);
    console.log('Parsed body:', parsedBody);
    const username = parsedBody.username || '';
    const password = parsedBody.password || '';
    console.log('Username:', username, 'Password:', password);

    if (username === 'demo' && password === 'demo123') {
      console.log('Login successful, redirecting with session');
      res.setHeader('Set-Cookie', 'carrier_session=demo; Path=/; SameSite=Lax');
      res.redirect('/api/carrier/search?session=demo');
      return;
    }

    res.status(401).send(renderLoginPage('Invalid credentials.'));
    return;
  }

  if (pathname === '/carrier/logout') {
    res.setHeader('Set-Cookie', 'carrier_session=; Path=/; Max-Age=0');
    res.redirect('/api/carrier/login');
    return;
  }

  if (pathname === '/carrier/search') {
    console.log('Search page - Cookie header:', req.headers.cookie);
    console.log('Query params:', parsedUrl.query);
    const cookies = getCookies(req);
    const sessionFromQuery = parsedUrl.query.session;
    console.log('Session from query:', sessionFromQuery);
    console.log('Session from cookie:', cookies.carrier_session);
    
    if (!cookies.carrier_session && !sessionFromQuery) {
      console.log('No session found, redirecting to login');
      res.redirect('/api/carrier/login');
      return;
    }
    console.log('Session found, showing search page');
    const sessionToken = sessionFromQuery || cookies.carrier_session || 'demo';
    res.send(renderSearchPage(sessionToken));
    return;
  }

  if (pathname === '/carrier/results') {
    const cookies = getCookies(req);
    const sessionFromQuery = parsedUrl.query.session;
    if (!cookies.carrier_session && !sessionFromQuery) {
      res.redirect('/api/carrier/login');
      return;
    }
    const results = filterRates(spotRates, parsedUrl.query);
    res.send(renderResultsPage(parsedUrl.query, results));
    return;
  }

  res.status(404).send('Not Found');
});
