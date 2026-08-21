/**
 * UI smoke test.
 *
 *   node tests/ui.test.js
 *
 * Runs each page's real client script against a minimal DOM and a stubbed
 * google.script.run wired to the ACTUAL server functions. Syntax checking alone
 * missed a page that threw at load and rendered nothing at all, so this executes
 * the render path and asserts that something reached the screen.
 */
const fs = require('fs');
const path = require('path');
const { check, section, summarise } = require('./stubs');

const UI = path.join(__dirname, '..', 'src', 'ui');

// ------------------------------------------------------------- fixtures
seedConfig_();
seedPolicy_();
seedAll();
Db.append('Admins', { email: 'admin@ipu.ac.in', name: 'Hostel Admin',
                      role: 'SUPER_ADMIN', campus: 'ALL', active: true });
global.ScriptApp = { getService: () => ({ getUrl: () => 'https://script.example/exec' }) };
const run = Allocator.runAndCommit({ seed: 'GGSIPU-2026', runId: 'RUN-UI',
                                     triggeredBy: 'admin@ipu.ac.in' });

// ------------------------------------------------------------ tiny DOM
function makeEl(id, known) {
  const self = {
    id, value: '', disabled: false, textContent: '',
    dataset: {}, children: [], style: {}, classList: { add() {}, remove() {} },
    addEventListener() {}, focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  let html = '';
  Object.defineProperty(self, 'innerHTML', {
    get() { return html; },
    set(v) {
      html = String(v);
      // Whatever markup was just written now exists in the document, exactly as
      // it would in a browser.
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) known.add(m[1]);
    }
  });
  return self;
}

function freshDom() {
  const nodes = {};
  const known = new Set(['root', 'chrome']);

  // Only elements that actually exist are returned. An earlier version of this
  // stub invented a node for any id asked for, which hid the very class of bug
  // that blanks a page: reaching for an element that is not on screen yet.
  function node(id) {
    if (!known.has(id)) return null;
    if (!nodes[id]) nodes[id] = makeEl(id, known);
    return nodes[id];
  }
  global.__known = known;
  global.document = {
    getElementById: node,
    createElement() { return makeEl('new', known); }
  };
  global.window = {
    top: { location: { reload() {}, href: '', pathname: '/' } },
    scrollTo() {}, location: { href: '' }
  };
  global.confirm = () => true;
  global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
  global.clearTimeout = () => {};
  return nodes;
}

/** google.script.run that calls the real server functions synchronously. */
function makeRunner(errors) {
  function build() {
    let ok = null, fail = null;
    const api = new Proxy({}, {
      get(_, prop) {
        if (prop === 'withSuccessHandler') return (h) => { ok = h; return api; };
        if (prop === 'withFailureHandler') return (h) => { fail = h; return api; };
        return function () {
          const args = Array.prototype.slice.call(arguments);
          try {
            const fn = global[prop];
            if (typeof fn !== 'function') throw new Error('no server function ' + prop);
            const result = fn.apply(null, args);
            if (ok) ok(JSON.parse(JSON.stringify(result === undefined ? null : result)));
          } catch (e) {
            if (fail) fail({ message: e.message });
            else errors.push(String(prop) + ': ' + e.message);
          }
          return api;
        };
      }
    });
    return api;
  }
  // The pages call google.script.run, so the stub has to have that shape.
  return { script: { get run() { return build(); } } };
}

function scriptOf(file) {
  const html = fs.readFileSync(path.join(UI, file), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // Apps Script substitutes template tags server-side before a browser sees the
  // page; stand in placeholders so the script parses here.
  return blocks.join('\n')
    .replace(/<\?=\s*webAppUrl\(\)\s*\?>/g, 'https://script.example/exec')
    .replace(/<\?!?=[\s\S]*?\?>/g, '({})');
}

const CHROME = scriptOf('chrome.html');

/**
 * Load chrome + a page script and report what happened.
 * A page that throws at load leaves #root empty, which is the bug this catches.
 */
function renderPage(file, sessionEmail) {
  const nodes = freshDom();
  const errors = [];
  global.Session = { getActiveUser: () => ({ getEmail: () => sessionEmail }) };
  global.google = makeRunner(errors);

  let threw = null;
  try {
    (0, eval)(CHROME + '\n' + scriptOf(file));
  } catch (e) {
    threw = e.message;
  }
  return {
    threw, errors,
    root: (nodes.root || {}).innerHTML || '',
    chrome: (nodes.chrome || {}).innerHTML || '',
    nodes
  };
}

// =========================================================== the tests
const student = Db.readAll('Students').find(s =>
  Db.findOne('Allocations', { appId: (Db.findOne('Applications', { studentId: s.studentId }) || {}).appId }));
const studentEmail = student.email;

section('Student portal');
let r = renderPage('student.html', studentEmail);
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the page body rendered', r.root.length > 800, r.root.length + ' bytes');
check('the allotment hero is present', r.root.indexOf('Your allotment') > 0);
check('the explanation panel is present', r.root.indexOf('Why you got this result') > 0);

section('Application form');
r = renderPage('apply.html', studentEmail);
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the form body rendered', r.root.length > 800, r.root.length + ' bytes');
check('preference chooser is present', r.root.indexOf('Room preferences') > 0);
check('roommate questionnaire is present', r.root.indexOf('Roommate questionnaire') > 0);

section('Admin dashboard');
r = renderPage('admin.html', 'admin@ipu.ac.in');
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the dashboard body rendered', r.root.length > 1500, r.root.length + ' bytes');
check('summary tiles are present', r.root.indexOf('Rooms allotted') > 0);
check('ledger status is present', r.root.indexOf('Audit ledger') > 0);
check('occupancy table is present', r.root.indexOf('Occupancy') > 0);

section('Verification page');
r = renderPage('verify.html', '');
check('script runs without throwing', !r.threw, r.threw || '');
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('something rendered', r.root.length > 200, r.root.length + ' bytes');

section('Sign-in page');
r = renderPage('index.html', '');
check('script runs without throwing', !r.threw, r.threw || '');
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('something rendered', r.root.length > 200, r.root.length + ' bytes');

section('Non-admin is refused the dashboard cleanly');
r = renderPage('admin.html', studentEmail);
check('script still runs', !r.threw, r.threw || '');
check('an error message is shown rather than a blank page',
  r.root.indexOf('banner') > 0 || r.root.indexOf('denied') > 0,
  'root was ' + r.root.length + ' bytes');

section('Navigation must escape the sandbox iframe');
r = renderPage('student.html', studentEmail);
check('navigation links target _top', r.chrome.indexOf('target="_top"') > 0,
  'a relative link navigates the sandboxed frame, not the app, and blanks the page');
check('navigation links are absolute',
  r.chrome.indexOf('href="https://') > 0,
  'the iframe is served from a different origin, so relative hrefs resolve wrongly');
const chromeSrc = fs.readFileSync(path.join(UI, 'chrome.html'), 'utf8');
check('the link helper is the single place this is handled',
  /function appUrl\(/.test(chromeSrc) && /target="_top"/.test(chromeSrc));

['student.html', 'admin.html', 'apply.html', 'verify.html', 'index.html'].forEach(function (f) {
  const src = fs.readFileSync(path.join(UI, f), 'utf8');
  check(f + ' publishes the web app URL', src.indexOf('WEBAPP_URL') > 0);
  const bareLinks = (src.match(/href="\?/g) || []).length;
  check(f + ' has no bare relative links', bareLinks === 0,
    bareLinks + ' found');
});

section('Layout: stacked text must not run together');
const css = fs.readFileSync(path.join(UI, 'styles.html'), 'utf8');
check('row title and detail are block-level',
  /\.rows\s+\.n[^{]*\{[^}]*display:\s*block/.test(css) ||
  /\.rows\s+\.n\s*,[^{]*\{[^}]*display:\s*block/.test(css),
  'inline spans would render "Hostel ADwarka Campus" with no break');

process.exit(summarise());
