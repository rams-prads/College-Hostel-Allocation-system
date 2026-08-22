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
  global.prompt = () => 'a reason';
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
function renderPage(file, sessionEmail, after) {
  const nodes = freshDom();
  const errors = [];
  global.Session = { getActiveUser: () => ({ getEmail: () => sessionEmail }) };
  global.google = makeRunner(errors);

  let threw = null;
  try {
    // Indirect eval, so the page's own functions and state land on the global
    // object and `after` can drive the wizard the way a click would.
    (0, eval)(CHROME + '\n' + scriptOf(file));
    if (after) (0, eval)(after);
  } catch (e) {
    threw = e.message;
  }
  // The stub does not nest nodes the way a browser does, so "what is on screen"
  // is every node's content, not just the outermost one.
  let all = '';
  Object.keys(nodes).forEach(function (k) { all += nodes[k].innerHTML || ''; });

  return {
    threw, errors,
    root: (nodes.root || {}).innerHTML || '',
    chrome: (nodes.chrome || {}).innerHTML || '',
    screen: all,
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
check('the page body rendered', r.screen.length > 800, r.screen.length + ' bytes');
check('the allotment hero is present', r.screen.indexOf('Your allotment') > 0);
check('the explanation panel is present', r.screen.indexOf('Why you got this result') > 0);

section('Application form - returning student');
r = renderPage('apply.html', studentEmail);
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the form body rendered', r.screen.length > 1200, r.screen.length + ' bytes');
check('opens on the preference step', r.screen.indexOf('Room preferences') > 0);
check('shows the step indicator', r.screen.indexOf('class="wiz"') > 0);
check('a returning student is not asked to register again',
  r.screen.indexOf('registers you') < 0);

section('Application form - brand new student');
r = renderPage('apply.html', 'someone.brand.new@example.com');
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('registration is offered rather than a dead end',
  r.screen.indexOf('registers you') > 0,
  'a student not in the registry must still be able to apply');
check('opens on personal details', r.screen.indexOf('About you') > 0);
check('asks for an enrolment number', r.screen.indexOf('enrolment number') > 0);
check('asks for gender, since hostels are single-gender',
  r.screen.indexOf('Gender') > 0);
check('the wizard has all seven steps',
  (r.screen.match(/<li class="[^"]*"[^>]*onclick="goStep/g) || []).length === 7,
  (r.screen.match(/onclick="goStep/g) || []).length + ' steps');

section('Campus is declared once, at registration');
const atStep = name => 'step = STEPS.indexOf("' + name + '"); paint();';

r = renderPage('apply.html', 'someone.brand.new@example.com', atStep('Course'));
check('script survives stepping to the course page', !r.threw, r.threw || '');
check('the course step asks which campus they are admitted to',
  r.screen.indexOf('Campus you are admitted to') > 0);
check('both campuses are offered',
  r.screen.indexOf('Dwarka Campus') > 0 && r.screen.indexOf('East Delhi Campus') > 0);
check('and it is presented as a fact, not a preference',
  r.screen.indexOf('Fixed when you joined') > 0);

r = renderPage('apply.html', 'someone.brand.new@example.com', atStep('Roommate'));
check('script survives stepping to the roommate page', !r.threw, r.threw || '');
check('the roommate questionnaire still renders',
  r.screen.indexOf('go to sleep') > 0);
check('it no longer asks about smoking', r.screen.toLowerCase().indexOf('smok') < 0,
  'hostels are non-smoking - it is not a lifestyle preference to be matched on');

section('Application form - the preference step');
r = renderPage('apply.html', studentEmail, atStep('Preferences'));
check('script survives stepping to the preference page', !r.threw, r.threw || '');
check('no campus choice is offered', r.screen.indexOf('Campus preference') < 0,
  'a student cannot choose the campus they were admitted to');
check('the campus restriction is stated instead',
  r.screen.indexOf('fixed by your admission') > 0);
check('only the student\'s own campus appears in the options', (() => {
  const other = student.campus === 'DWARKA' ? 'East Delhi Campus' : 'Dwarka Campus';
  const mine = student.campus === 'DWARKA' ? 'Dwarka Campus' : 'East Delhi Campus';
  return r.screen.indexOf(mine) > 0 && r.screen.split(other).length - 1 === 0;
})(), 'offering an option that can never be granted is worse than offering none');

section('Identity verification - the student side');
r = renderPage('student.html', studentEmail);
check('the identity card is present', r.screen.indexOf('Identity verification') > 0);
check('an unverified student is offered the field',
  r.screen.indexOf('aadhaarInput') > 0);
check('the storage promise is stated where the number is asked for',
  r.screen.indexOf('never saved') > 0,
  'a student handing over an Aadhaar number is owed this before they type it');

// A submitted identity, so the admin queue below has something real in it.
const idStudent = Db.readAll('Students').find(s => s.email !== studentEmail);
const IDNUM = (function () {
  const p = '45678901234';
  return p + Identity.verhoeffDigit(p);
})();
global.Session = { getActiveUser: () => ({ getEmail: () => idStudent.email }) };
Identity.submit(idStudent.studentId, IDNUM);

r = renderPage('student.html', idStudent.email);
check('a submitted identity shows the masked number',
  r.screen.indexOf('XXXX XXXX ' + IDNUM.slice(-4)) > 0);
check('and the field is withdrawn once it is submitted',
  r.screen.indexOf('aadhaarInput') < 0,
  'an input that can no longer be used should not be on screen');
check('the full number never reaches the page',
  r.screen.indexOf(IDNUM.slice(0, 8)) < 0,
  'the rendered HTML is the last place it could leak');

section('Admin dashboard');
r = renderPage('admin.html', 'admin@ipu.ac.in');
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the dashboard body rendered', r.screen.length > 1500, r.screen.length + ' bytes');
check('summary tiles are present', r.screen.indexOf('Rooms allotted') > 0);
check('ledger status is present', r.screen.indexOf('Audit ledger') > 0);
check('occupancy table is present', r.screen.indexOf('Occupancy') > 0);

section('Identity verification - the admin side');
r = renderPage('admin.html', 'admin@ipu.ac.in');
check('the verification section is on the dashboard',
  r.screen.indexOf('Identity verification') > 0);
check('the waiting applicant is listed', r.screen.indexOf(idStudent.name) > 0);
check('their number is shown masked',
  r.screen.indexOf('XXXX XXXX ' + IDNUM.slice(-4)) > 0);
check('the full number is not in the admin page either',
  r.screen.indexOf(IDNUM.slice(0, 8)) < 0,
  'an admin screen is the one most likely to be shared or photographed');
check('verify and reject are both offered',
  r.screen.indexOf('&gt;Verify&lt;') > 0 || r.screen.indexOf('>Verify<') > 0);

section('Verification page');
r = renderPage('verify.html', '');
check('script runs without throwing', !r.threw, r.threw || '');
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('something rendered', r.screen.length > 200, r.screen.length + ' bytes');

section('Sign-in page');
r = renderPage('index.html', '');
check('script runs without throwing', !r.threw, r.threw || '');
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('something rendered', r.screen.length > 200, r.screen.length + ' bytes');

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
