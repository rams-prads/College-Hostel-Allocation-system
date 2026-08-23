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
  const attrs = {};
  global.document = {
    getElementById: node,
    createElement() { return makeEl('new', known); },
    // A page may set the theme or tag the body before it paints. Leaving these
    // off the stub meant the whole dashboard threw at line one.
    documentElement: {
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k]; }
    },
    body: { classList: { add() {}, remove() {}, contains() { return false; } } }
  };
  global.__attrs = attrs;
  global.window = {
    top: { location: { reload() {}, href: '', pathname: '/' } },
    scrollTo() {}, location: { href: '' }
  };
  global.confirm = () => true;
  global.prompt = () => 'a reason';
  // Short delays are deferred paints and should run; long ones are timeouts
  // waiting on a server that, in this harness, has already answered. Firing
  // those immediately would have every page render its own timeout banner.
  global.setTimeout = (fn, ms) => {
    if (!ms || ms < 1000) { try { fn(); } catch (e) {} }
    return 0;
  };
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
    // Server-side conditionals that resolve to a plain string, not an object.
    .replace(/<\?=\s*\(typeof[\s\S]*?\?>/g, '')
    .replace(/<\?=\s*logoUrl\(\)\s*\?>/g, '')
    .replace(/<\?!?=[\s\S]*?\?>/g, '({})');
}

const CHROME = scriptOf('chrome.html');

// Partials the pages pull in with include(). Apps Script splices these in
// at serve time; we eval them alongside chrome.
const PARTIALS = scriptOf('wander.html');

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
    (0, eval)(CHROME + '\n' + PARTIALS + '\n' + scriptOf(file));
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

check('preferences and documents are stacked, not side by side', (() => {
  // They used to share a two-column grid, which put the only thing on this page
  // the student still has to ACT on into a half-width column beside a list they
  // can do nothing about.
  const prefAt = r.screen.indexOf('Your room preferences');
  const docAt  = r.screen.indexOf('Documents required of you');
  if (prefAt < 0 || docAt < 0 || docAt < prefAt) return false;
  // Nothing may wrap the pair back into a grid.
  return !/class="cols"[^>]*>\s*<section[^>]*>[\s\S]{0,4000}?Documents required of you/
    .test(r.screen);
})(), 'documents belong full width, below the preferences');

check('at most two documents are ever asked for', (() => {
  const asked = (r.screen.match(/id="u-([A-Z_]+)"/g) || [])
    .map(m => m.replace(/[^A-Z_]/g, ''));
  const uniq = asked.filter((v, i) => asked.indexOf(v) === i);
  return uniq.length <= 2 && uniq.every(t => t === 'AADHAAR' || t === 'ID_CARD');
})(), 'the rest of the checklist is collected on paper at the counter');

// A student the office has not finished checking. That is who the form is for
// now - an allotted application is settled, and settled is not editable.
const openApp = Db.readAll('Applications').find(a => a.status === 'SUBMITTED');
const openStudent = Db.byId('Students', openApp.studentId);
const openEmail = openStudent.email;

section('Application form - a student the office has not finished checking');
r = renderPage('apply.html', openEmail);
check('script runs without throwing', !r.threw, r.threw || '');
check('no unhandled server errors', r.errors.length === 0, r.errors.join('; '));
check('the masthead rendered', r.chrome.indexOf('masthead') > 0);
check('the form body rendered', r.screen.length > 1200, r.screen.length + ' bytes');
check('a returning student is not asked to register again',
  r.screen.indexOf('registers you') < 0);
check('shows the step indicator', r.screen.indexOf('class="wiz"') > 0);

check('the details they declared are editable, not just the room choices',
  r.screen.indexOf('About you') > 0 &&
  (r.screen.match(/<li class="[^"]*"[^>]*onclick="goStep/g) || []).length === 7,
  'not being able to fix a typed PIN code after submitting is what sent people to the office');
check('and the form starts from what we already hold',
  r.screen.indexOf('value="' + openStudent.name + '"') > 0,
  'an edit that starts blank is a re-typing exercise, and loses whatever nobody retypes');
check('it says plainly how long they can keep changing it',
  r.screen.indexOf('verified both your identity and your documents') > 0);
check('and does not offer to un-submit it as a draft',
  r.screen.indexOf('Save as draft') < 0,
  'a submitted application has no draft state to go back to');

section('Application form - once both checks have passed');
(() => {
  const app = Db.readAll('Applications').find(a => a.status === 'SUBMITTED' &&
                                                   a.appId !== openApp.appId);
  const st = Db.byId('Students', app.studentId);
  Db.update('Applications', app.appId, { docStatus: 'VERIFIED' });
  Db.append('Identity', { studentId: st.studentId, aadhaarRef: 'x', aadhaarLast4: '1234',
                          enrolmentNorm: '', status: 'VERIFIED', riskScore: 0,
                          findingsJson: null, submittedAt: new Date(),
                          verifiedBy: 'admin@ipu.ac.in', verifiedAt: new Date(), note: '' });
  Db.invalidate('Applications'); Db.invalidate('Identity');

  const t = renderPage('apply.html', st.email);
  check('the form is not rendered at all', t.screen.indexOf('class="wiz"') < 0,
    'a form the server will refuse is a student typing a correction twice and losing it twice');
  check('and it says why', t.screen.indexOf('now fixed') > 0);
  check('the portal stops offering the edit link too',
    renderPage('student.html', st.email).chrome.indexOf('Edit Application') < 0,
    'a tab leading to a locked page is a promise the next screen has to take back');

  // Put it back, so nothing after this depends on a record this test moved.
  Db.update('Applications', app.appId, { docStatus: 'PENDING' });
  Db.update('Identity', st.studentId, { status: 'SUBMITTED' });
  Db.invalidate('Applications'); Db.invalidate('Identity');
})();

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
check('the course step asks the admission category', (() => {
  return r.screen.indexOf('Admission category') > 0 &&
         r.screen.indexOf('Outside Delhi') > 0;
})(), 'it decides which queue the applicant is in, and no marks move anyone between queues');
check('and asks a first-year for their class 12 best five', (() => {
  // The marks field only appears once a year of study is chosen, so choose one.
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "BTMT"; reg.year = 1; paint();');
  return t.screen.indexOf('Qualifying examination') > 0 &&
         t.screen.indexOf('class 12') > 0;
})(), 'which is what the brochure ranks a first-year on');

check('the school is shown, not asked for', (() => {
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "BTMT"; paint();');
  // Named, so the applicant can see what their course implied...
  const shows = /School: <strong>University School of Automation/.test(t.screen);
  // ...and not a control, because a course already names its school.
  const asks = /setReg\(&quot;school&quot;/.test(t.screen) ||
               /'school'/.test(t.screen);
  return shows && !asks;
})(), 'it was a dropdown fed by a list that no longer had that shape, so it was always empty');

check('no select on the form is left with nothing in it', (() => {
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "BTMT"; reg.year = 1; paint();');
  // A select whose only child is the placeholder is a question nobody can answer.
  const empties = (t.screen.match(/<select[^>]*>\s*<option value="">Select&hellip;<\/option>\s*<\/select>/g) || []);
  return empties.length === 0;
})(), 'an empty required dropdown is a dead end with a red asterisk on it');

check('a lateral-entry programme is never offered a first year', (() => {
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "LE-BTMT"; paint();');
  return t.screen.indexOf('>Year 2<') > 0 && t.screen.indexOf('>Year 1<') < 0;
})(), 'they enter in the second year, so a first year would describe a student who cannot exist');

check('and is asked about the diploma it entered on, not class 12', (() => {
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "LE-BTMT"; reg.year = 2; paint();');
  return t.screen.indexOf('diploma or B.Sc') > 0;
})());
check('and a continuing student for their last semester result', (() => {
  const t = renderPage('apply.html', 'someone.brand.new@example.com',
    'step = STEPS.indexOf("Course"); reg.programme = "BTMT"; reg.year = 3; paint();');
  return t.screen.indexOf('preceding semester') > 0;
})());
check('it no longer asks for a CGPA or an entrance rank',
  r.screen.indexOf('CGPA') < 0 && r.screen.indexOf('Entrance') < 0,
  'the brochure ranks on a percentage, and asking for a figure nobody uses wastes the applicant');
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
r = renderPage('apply.html', openEmail, atStep('Preferences'));
check('script survives stepping to the preference page', !r.threw, r.threw || '');
check('no campus choice is offered', r.screen.indexOf('Campus preference') < 0,
  'a student cannot choose the campus they were admitted to');
check('the campus restriction is stated instead',
  r.screen.indexOf('fixed by your admission') > 0);
check('only the student\'s own campus appears in the options', (() => {
  const other = openStudent.campus === 'DWARKA' ? 'East Delhi Campus' : 'Dwarka Campus';
  const mine = openStudent.campus === 'DWARKA' ? 'Dwarka Campus' : 'East Delhi Campus';
  return r.screen.indexOf(mine) > 0 && r.screen.split(other).length - 1 === 0;
})(), 'offering an option that can never be granted is worse than offering none');

section('Reporting a problem is a residents desk');

(() => {
  const res = renderPage('student.html', studentEmail);
  check('a student holding a room is offered it',
    res.screen.indexOf('Report a problem') > 0);
  check('and it is framed around living there, not around the application',
    /geyser|water, power, the wifi, the mess/.test(res.screen),
    'the box used to sit beside the document screens collecting questions they answered');

  const wl = Db.readAll('Waitlist')[0];
  const wlApp = Db.byId('Applications', wl.appId);
  const wlEmail = Db.byId('Students', wlApp.studentId).email;
  const pending = renderPage('student.html', wlEmail);
  check('a student with no room is not', pending.screen.indexOf('Report a problem') < 0,
    'there is nothing to report about a room nobody has been given');
  check('and nothing on that page invites a grievance either',
    pending.screen.toLowerCase().indexOf('raise a grievance') < 0);
})();

section('Can I still fix this?');

(() => {
  const open = renderPage('student.html', openEmail);
  check('an unverified application says so on the page itself',
    open.screen.indexOf('can still be changed') > 0,
    'it used to be answered only by a link in the footer, which nobody read');
  check('with the way to do it right there',
    open.screen.indexOf('Edit my application') > 0);

  const settled = renderPage('student.html', studentEmail);
  check('an allotted one says the opposite',
    settled.screen.indexOf('can still be changed') < 0);
})();

section('Document upload');
r = renderPage('student.html', studentEmail);
check('the documents card offers an upload control', r.screen.indexOf('Upload') > 0,
  'the endpoint existed but nothing on any page called it');
check('a file input is present for a required document',
  r.screen.indexOf('type=\"file\"') > 0);
check('the accept list matches what the server allows',
  r.screen.indexOf('.pdf,.jpg,.jpeg,.png,.heic,.webp') > 0,
  'offering a file type the server refuses wastes the upload');
check('the size limit is stated before the upload, not after',
  r.screen.indexOf('8 MB') > 0);

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
check('occupancy opens on its own tab', (() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("occupancy");');
  return t.screen.indexOf('Occupancy and vacancies') > 0;
})());
check('students opens on its own tab', (() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("students");');
  return t.screen.indexOf('Look up a student') > 0;
})());
check('the document queue finally has a screen', (() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("verification");');
  return t.screen.indexOf('Documents needing a decision') > 0;
})(), 'apiAdminDocQueue existed since Phase 4 with nothing rendering it');

section('The waiting list has a screen of its own');

(() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("waitlist");');
  check('the tab renders', t.screen.indexOf('Waiting list') > 0);
  check('no unhandled server errors', t.errors.length === 0, t.errors.join('; '));

  const rows = (t.screen.match(/<tbody>[\s\S]*?<\/tbody>/)[0].match(/<tr>/g) || []).length;
  check('it shows 25 at a time', rows === 25, rows + ' rows');

  const total = apiAdminWaitlist({ page: 1, pageSize: 25 }).total;
  check('and says how many there are altogether',
    t.screen.indexOf(String(total)) > 0, total + ' waiting');
  check('with a way to reach the next page', t.screen.indexOf('wlGo(2)') > 0);
  check('and no way back from the first',
    /wlGo\(0\)[^>]*>/.test(t.screen) === false ||
    /disabled onclick="wlGo\(0\)/.test(t.screen),
    'a Previous button on page one is a button that does nothing');

  const p2 = renderPage('admin.html', 'admin@ipu.ac.in',
    'goTab("waitlist"); wlGo(2);');
  check('the next page shows different people', (() => {
    const first = apiAdminWaitlist({ page: 1, pageSize: 25 }).rows[0];
    const second = apiAdminWaitlist({ page: 2, pageSize: 25 }).rows[0];
    return p2.screen.indexOf(second.enrollmentNo) > 0 &&
           p2.screen.indexOf(first.enrollmentNo) < 0;
  })());
  check('and page 2 offers the way back', p2.screen.indexOf('wlGo(1)') > 0);

  check('the rail carries the number waiting, so nobody has to open it to find out',
    t.screen.indexOf('<span>Waiting list</span><span class="cnt">' + total + '</span>') > 0,
    'the count belongs where the work is chosen, not behind the click that chooses it');

  check('each row says which priority group put them there',
    t.screen.indexOf('Priority group') > 0 &&
    (t.screen.indexOf('Outside Delhi') > 0 || t.screen.indexOf('Delhi category') > 0),
    'the queue is not sorted on one number, and a table that shows one looks wrong');
  check('a student can be opened from the row',
    t.screen.indexOf('viewStudent(') > 0);
})();

section('The dashboard is a workspace, not one long page');
r = renderPage('admin.html', 'admin@ipu.ac.in');
check('it holds itself to the light palette',
  global.__attrs['data-theme'] === 'light',
  'an officer reads this beside printed forms');
check('there is a section rail', r.screen.indexOf('class="anav"') > 0);
check('every section is on it',
  ['Overview', 'Allocation', 'Occupancy', 'Verification', 'Students', 'Requests',
   'Policy', 'Operations'].every(t => r.screen.indexOf('>' + t + '<') > 0));
check('exactly one section is open',
  (r.screen.match(/aria-current="true"/g) || []).length === 1);
check('it opens on the overview', r.screen.indexOf('Rooms allotted') > 0);
check('and does not also render the other seven',
  r.screen.indexOf('Look up a student') < 0,
  'stacking everything on one page is what this replaced');

section('Document reading is on the dashboard');
r = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("verification");');
check('the reading summary renders', r.screen.indexOf('Document reading') > 0);
check('it states what is actually compared',
  r.screen.indexOf('PIN code compared') > 0,
  'an officer should know what the machine checked and what it did not');
check('it says a difference is only raised when it matters',
  r.screen.indexOf('change') > 0 && r.screen.indexOf('outcome') > 0);

section('Identity verification - the admin side');
r = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("verification");');
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

section('Grievances can be closed, not only read');

(function () {
  // A grievance the automatic check could not settle, so it is waiting on a
  // person - which is the only kind the queue is for.
  const wl = Db.readAll('Waitlist')[0];
  global.Session = { getActiveUser: () => ({ getEmail: () => 'admin@ipu.ac.in' }) };
  const t = Grievance.raise(wl.appId, 'My rank was good and I got no room at all', 'student');
  Db.update('Grievances', t.ticketId, { status: 'ESCALATED' });
  Db.invalidate('Grievances');

  let rr = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("requests");');
  check('the grievance is shown in full, not truncated in a table',
    rr.screen.indexOf('My rank was good and I got no room at all') > 0);
  check('it offers a way to close it', rr.screen.indexOf('Mark resolved') > 0,
    'the inbox was read-only, so a resolved complaint stayed open forever');
  check('and a way to open the student it is about',
    rr.screen.indexOf('Open their portal') > 0);
  check('the count says what is waiting on a person',
    rr.screen.indexOf('waiting on you') > 0);

  // Close it the way the button does.
  apiAdminResolveGrievance(t.ticketId, 'Checked the run; the outcome was correct.');

  rr = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("requests");');
  check('a resolved complaint leaves the waiting list',
    rr.screen.indexOf('Nothing is waiting on you') > 0);
  check('and is still readable, with what was done',
    rr.screen.indexOf('already settled') > 0 &&
    rr.screen.indexOf('the outcome was correct') > 0);
  check('the student is told the same words', (() => {
    const g = Db.byId('Grievances', t.ticketId);
    return g.status === 'RESOLVED' && /outcome was correct/.test(g.resolution);
  })());
})();

section('The lifecycle is spelled out, in order');
r = renderPage('admin.html', 'admin@ipu.ac.in');
check('the overview shows how a place is allotted',
  r.screen.indexOf('How a place is allotted') > 0,
  'everything needed was on the page; the order was not');
check('every stage is named', ['Students apply', 'Documents are checked',
  'Allocation runs', 'Letters and notices go out'].every(t => r.screen.indexOf(t) > 0));
check('exactly one stage is marked as the next thing to do',
  (r.screen.match(/<li class="now"/g) || []).length <= 1);

section('The crest is configurable');
check('with no LOGO_URL it falls back to the monogram', (() => {
  const rr = renderPage('index.html', '');
  return rr.chrome.indexOf('>IPU<') > 0 && rr.chrome.indexOf('<img') < 0;
})(), 'a broken image in the masthead looks worse than no image');

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
check('it offers a way to actually sign in',
  /<a[^>]+class="btn"/.test(r.screen) || /<button/.test(r.screen),
  'this page shipped with no button on it - a page whose only job is to get ' +
  'the visitor somewhere must give them something to press');
check('it asks for an email address', r.screen.indexOf('siEmail') > 0);
check('the address may be any address',
  /Any address works/i.test(r.screen) && /college one/i.test(r.screen),
  'a first-year has no college address for months after allocation, and the page has ' +
  'to say so before they conclude this is not for them');
check('it says a code is coming, before asking for anything',
  /six-digit code/i.test(r.screen),
  'a login box that behaves unusually and explains nothing reads as broken');
check('and it does not argue its own case at length', (() => {
  // The whole job of this page is to take one email address. Word count is the
  // measure that actually went wrong here: the copy grew until the field it
  // was introducing was the smallest thing on the screen.
  const words = r.screen.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length;
  return words < 70;
})(), 'a sign-in page reading like a brochure is the thing being fixed');
check('it does not demand a Google account',
  r.screen.toLowerCase().indexOf('google account') < 0,
  'the whole point is that the students who need this most do not have one');

check('the code step can send another without retyping the address', (() => {
  const t = renderPage('index.html', '', `
    _siEmail = 'someone@example.com';
    setHtml('signinBody', codeStep(_siEmail));
  `);
  return /send another code/i.test(t.screen) &&
         t.screen.indexOf('someone@example.com') > 0 &&
         t.screen.indexOf('siCode') > 0;
})(), 'the only way to resend used to be going back and typing the address in again');

check('and a way back to a different address', (() => {
  const t = renderPage('index.html', '', `
    _siEmail = 'someone@example.com';
    setHtml('signinBody', codeStep(_siEmail));
  `);
  return /onclick="backToEmail\(\)"/.test(t.screen);
})());

check('a code that has not arrived is a normal thing, and the page says so', (() => {
  const t = renderPage('index.html', '', `
    setHtml('signinBody', codeStep('someone@example.com'));
  `);
  return /spam/i.test(t.screen);
})(), 'otherwise the only conclusion available is that the portal is broken');

section('The application form says how much is left');

(() => {
  const at = n => 'step = ' + n + '; paint();';
  const first = renderPage('apply.html', 'brand.new@example.com', at(0));
  const last  = renderPage('apply.html', 'brand.new@example.com', at(6));

  check('there is a progress bar, and it moves',
    /class="wizbar"><i style="width:0%"/.test(first.screen) &&
    /class="wizbar"><i style="width:100%"/.test(last.screen),
    'seven identical chips told you the names of the steps and not where you were');
  check('the step is counted in words as well',
    first.screen.indexOf('Step 1 of 7') > 0 && last.screen.indexOf('Step 7 of 7') > 0);
  check('and how many are left is stated outright',
    first.screen.indexOf('6 steps to go') > 0,
    'the question a long form has to answer before somebody starts it');
  check('the step you are on is named at the top',
    /class="stepname">Your details</.test(first.screen));

  check('every step explains itself in a sentence', (() => {
    const missing = [0, 1, 2, 3, 4, 5, 6].filter(i =>
      renderPage('apply.html', 'brand.new@example.com', at(i))
        .screen.indexOf('class="steplead"') < 0);
    return missing.length === 0;
  })(), 'a step that is only a row of labels leaves you guessing why it is being asked');

  check('the review lets you go back and fix what you are reading',
    /class="linkish" onclick="goStep\(0\)"/.test(last.screen) &&
    /class="linkish" onclick="goStep\(4\)"/.test(last.screen),
    'reading back a mistake and then hunting for the step that made it is where people stop');

  check('and it says what happens after submitting', last.screen.indexOf('class="next"') > 0);
})();

section('An account is one thing or the other');

// The rule: an administrator sees the dashboard and never the student portal;
// a student sees their application and never the dashboard. Neither has a link
// to the other, and neither has to know the other's address.
(() => {
  const asAdmin = renderPage('student.html', 'admin@ipu.ac.in');
  check('an administrator opening the portal is taken to the dashboard',
    /\?page=admin$/.test(window.top.location.href), window.top.location.href);
  check('and is not shown a student portal on the way',
    asAdmin.screen.indexOf('Your allotment') < 0 &&
    asAdmin.screen.indexOf('Room preferences') < 0,
    'the dashboard used to be reachable only by finding a tab on this page');

  const asStudent = renderPage('student.html', studentEmail);
  check('a student still gets their own portal',
    asStudent.screen.indexOf('Your allotment') > 0);
  check('and is offered no route into administration',
    asStudent.chrome.indexOf('page=admin') < 0,
    'a tab nobody may use is a question the reader has to answer for themselves');

  const admin = renderPage('admin.html', 'admin@ipu.ac.in');
  check('the dashboard offers no route into a student portal either',
    admin.chrome.indexOf('Student View') < 0,
    'an administrator has no application of their own to look at');
  check('but can still open a student inside the dashboard',
    admin.screen.indexOf('viewStudent(') > 0 ||
    renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("students");')
      .screen.indexOf('Look up a student') > 0,
    'looking IN at a student is a different thing from using the portal as one');
})();

check('an administrator gets no application form either', (() => {
  renderPage('apply.html', 'admin@ipu.ac.in');
  return /\?page=admin$/.test(window.top.location.href);
})(), window.top.location.href);

check('a student who reaches the dashboard is told plainly, not shown an error', (() => {
  // Signed in, not an administrator. That is somebody who followed a link, not
  // a fault, and what they need is the way back rather than a red box.
  const t = renderPage('admin.html', studentEmail, 'SESSION.token = "x"; load();');
  return t.screen.indexOf('for hostel administrators') > 0 &&
         t.screen.indexOf('Go to my application') > 0;
})());

check('signing in lands each account in its own place', (() => {
  const src = codeOf('index.html');
  // Not "go to the portal and let it bounce you": ask, then move once.
  return /homeFor\(who\)/.test(src) && /apiWhoAmI/.test(src);
})(), 'the extra hop was a page load spent on a screen the reader may not use');

check('signing out redraws the page instead of leaving it', (() => {
  // A signed-out visitor being sent to the deployment URL is the moment Google
  // is most likely to answer with one of its own error pages instead of ours,
  // and there is nothing to go there FOR: the session is a token this browser
  // holds, so signing out is discarding it.
  const t = renderPage('student.html', studentEmail, `
    window.top.location.href = '';
    signOut();
  `);
  return !t.threw &&
         window.top.location.href === '' &&
         t.screen.indexOf('id="siEmail"') > 0;
})(), window.top.location.href || 'stayed put');

check('every page that can sign someone in can sign them out again', (() => {
  return ['student.html', 'apply.html', 'admin.html', 'index.html']
    .every(f => /function onSignedOut/.test(codeOf(f)));
})(), 'without one, signOut falls back to navigating, which is what this avoids');

check('a navigation that does not take offers a link instead', (() => {
  // The sandbox this app runs in permits top-level navigation only by user
  // activation, so a redirect started from a page-load callback can be refused
  // with no error to catch. The page must not simply stop.
  const src = codeOf('chrome.html');
  return /offerLink_/.test(src) && /target="_top"/.test(src);
})(), 'a page that has quietly stopped is indistinguishable from a hang');

check('an administrator is routed by the server when the server can tell', (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'Main.gs'), 'utf8');
  return src.indexOf("session.isAdmin && !params.demo") > 0 &&
         src.indexOf("page === 'home' || page === 'apply'") > 0;
})(), 'doing it in doGet saves the browser a navigation, which is the part that can fail');

section('Every page can sign someone in, not just the front one');
// A student portal reached without a session used to be a dead end that told
// the visitor to go and be signed in. Each page now carries the panel itself.
['student.html', 'apply.html', 'admin.html'].forEach(function (f) {
  const src = fs.readFileSync(path.join(UI, f), 'utf8');
  check(f + ' falls back to the sign-in panel', src.indexOf('signInPanel(') > 0);
});
check('no page still tells the visitor to go and be signed in elsewhere', (() => {
  return ['student.html', 'apply.html', 'index.html'].every(f =>
    fs.readFileSync(path.join(UI, f), 'utf8').indexOf('while signed in') < 0);
})(), 'that instruction was never actionable from inside the page');

section('A page must never be left on a spinner');

// google.script.run does NOT route an exception thrown inside a success handler
// to the failure handler. It goes nowhere, and the page keeps showing whatever
// it had - in every case here, a loading spinner. That is not a hypothetical:
// it is what a submitted application looked like from the outside.
check('a throwing success handler surfaces an error', (() => {
  const nodes = freshDom();
  global.Session = { getActiveUser: () => ({ getEmail: () => studentEmail }) };
  global.google = makeRunner([]);
  (0, eval)(CHROME);
  document.getElementById('root').innerHTML = '<div>loading</div>';

  // A handler that throws, exactly as a rendering bug would.
  srv().withSuccessHandler(function () { throw new Error('boom while rendering'); })
       .apiWhoAmI();

  const screen = Object.keys(nodes).map(k => nodes[k].innerHTML || '').join('');
  return screen.indexOf('Could not display the result of') > 0 &&
         screen.indexOf('boom while rendering') > 0;
})(), 'otherwise the user waits forever with nothing to report');

check('a server error still reaches the page when no handler was attached', (() => {
  const nodes = freshDom();
  global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
  global.google = makeRunner([]);
  (0, eval)(CHROME);
  document.getElementById('root').innerHTML = '<div>loading</div>';

  srv().apiRequestSignInCode('not-an-email');     // throws server-side

  const screen = Object.keys(nodes).map(k => nodes[k].innerHTML || '').join('');
  return screen.indexOf('banner err') > 0;
})(), 'a call with no failure handler used to fail silently');

check('a slow call eventually says so', (() => {
  const nodes = freshDom();
  // Run the long timer this time, and never answer.
  global.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
  global.google = { script: { run: new Proxy({}, {
    get: () => function () { return this; }        // accepts the call, never replies
  }) } };
  (0, eval)(CHROME);
  document.getElementById('root').innerHTML = '<div>loading</div>';
  try { srv().withSuccessHandler(function () {}).apiWhoAmI(); } catch (e) { /* stub */ }

  const screen = Object.keys(nodes).map(k => nodes[k].innerHTML || '').join('');
  return screen.indexOf('taking longer') > 0;
})(), 'a spinner with no deadline is indistinguishable from a hang');

section('An empty response says it is empty');

// google.script.run hands the success handler null when it cannot encode a
// return value, rather than failing. The page then reads a field off nothing
// and reports a TypeError naming whichever field it asked for first, which is
// never the fault - "Cannot read properties of null (reading 'isAdmin')" was
// two separate reports of exactly this.
global.apiProbeNothing = function () { return null; };

(() => {
  const t = renderPage('student.html', studentEmail, `
    setHtml('root', '');
    srv().withSuccessHandler(render).apiProbeNothing();
  `);
  check('the page does not throw', !t.threw, t.threw || '');
  check('and does not blame a field that had nothing to do with it',
    t.screen.indexOf("reading 'isAdmin'") < 0);
  check('it says the server sent nothing back',
    /sent nothing back/.test(t.screen), 'the message has to point somewhere useful');
  check('and names where to look if it persists',
    /page=diag/.test(t.screen),
    'a deployment older than the code is the likeliest cause and takes ten seconds to rule out');
})();

check('the dashboard is equally unbothered', (() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    srv().withSuccessHandler(render).apiProbeNothing();
  `);
  return !t.threw;
})());

section('An answer for a screen nobody is looking at any more');

// The reported fault: open the waiting list, wait, click another tab, and the
// answer lands on a node that no longer exists - "Cannot set properties of
// null" in a red box, over a page where nothing had gone wrong.
global.apiVanishingPanel = function () {
  // Stands in for the person navigating away while the call is in flight.
  global.__known.delete('probe');
  return { ok: true };
};

(() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    __known.add('probe');
    el('probe');
    window.__handlerRan = false;
    srv('probe').withSuccessHandler(function () { window.__handlerRan = true; })
      .apiVanishingPanel();
  `);
  check('the page does not throw', !t.threw, t.threw || '');
  check('the handler is not run at all', window.__handlerRan === false,
    'there is nowhere to put the answer, so running the painter can only fail');
  check('and nothing is reported as an error',
    t.screen.indexOf('fault in the portal') < 0 &&
    t.screen.indexOf('Cannot set properties') < 0,
    'a red box on a page where nothing went wrong is worse than the silence');
})();

check('an owner that never existed still fails loudly', (() => {
  // The other half of the rule. A typo in a call site must not be swallowed by
  // the same guard that forgives a person navigating away.
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    window.__typoRan = false;
    srv('nosuchpanelanywhere')
      .withSuccessHandler(function () { window.__typoRan = true; })
      .apiAdminWaitlist({ page: 1, pageSize: 25 });
  `);
  return window.__typoRan === true && !t.threw;
})(), 'forgiving a mistyped panel id would hide the bug rather than the noise');

check('every page writes through the helper that tolerates a missing node', (() => {
  const offenders = ['admin.html', 'student.html', 'apply.html', 'index.html',
                     'verify.html', 'chrome.html']
    .filter(f => /el\('[^']+'\)\.innerHTML\s*=/.test(codeOf(f)));
  return offenders.length === 0;
})(), 'one direct assignment is all it takes for the crash to come back');

check('setHtml says whether it landed, and never throws', (() => {
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    window.__missed = setHtml('definitely-not-on-this-page', 'x');
    window.__hit = setHtml('tabBody', el('tabBody').innerHTML);
  `);
  return !t.threw && window.__missed === false && window.__hit === true;
})());

check('an overtaken waiting-list answer is ignored', (() => {
  // Two clicks on Next start two calls, and nothing says they come back in the
  // order they went out. The older answer must not repaint the table.
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    goTab("waitlist");
    var stale = WL.seq;
    wlGo(2);
    // An answer from the earlier request, arriving late.
    paintWaitlistIfCurrent(stale, { rows: [], total: 999, matched: 0, page: 1,
                                    pages: 1, pageSize: 25, q: 'stale' });
  `);
  return !t.threw && t.screen.indexOf('stale') < 0;
})(), 'the table would show a page the pager underneath it says you are not on');

section('Nothing makes the user reload the page');

// Reloading the document to show the result of an action throws away the page,
// the scroll position and a second of the user's time to display information the
// server has already sent back. Worse, the reload wiped the confirmation that
// had just been written, so the button appeared to do nothing at all.
check('the student portal redraws in place after an action', (() => {
  const src = codeOf('student.html');
  return /function refreshView/.test(src) && !/reloadTop\(\)/.test(src);
})(), 'upload, identity and swap all used to reload the whole document');

check('a confirmation survives the redraw it triggers', (() => {
  const student = codeOf('student.html');
  const admin = codeOf('admin.html');
  // Both pages rebuild #root, so a note written before the rebuild has to be
  // carried through it rather than written and immediately discarded.
  return /refreshView\(['"]/.test(student) &&
         /PENDING_NOTE/.test(admin) &&
         /setHtml\('msg', banner\(PENDING_NOTE/.test(admin);
})());

check('the student page has somewhere for a message to land',
  /id="msg"/.test(codeOf('student.html')),
  'a note written into an element that does not exist is silently lost');

check('every page can draw itself after sign-in without navigating', (() => {
  return ['student.html', 'apply.html', 'admin.html']
    .every(f => /function onSignedIn/.test(codeOf(f)));
})(), 'the shared panel calls this instead of throwing the document away');

check('the admin dashboard keeps its confirmations', (() => {
  const src = codeOf('admin.html');
  // These three change state, so each must redraw AND say what happened.
  return /load\(\{ kind: 'good',\s*\n?\s*text: 'Allocation complete/.test(src) ||
         /load\(\{ kind: 'good',[\s\S]{0,80}Allocation complete/.test(src);
})());

section('Navigating out of the sandbox frame');

// The app runs in an iframe on googleusercontent.com while the address bar is on
// script.google.com. A cross-origin location may be WRITTEN to - navigation is
// allowed - but not READ from, and reload() must be read before it is called.
// Calling it threw on top of an upload that had already succeeded, so the
// student was told the portal was broken when their document was safely stored.
/** Source with comments removed - the claim is about code, not prose. */
function codeOf(file) {
  return fs.readFileSync(path.join(UI, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
}
check('no page reads reload() off the top frame', (() => {
  return ['student.html', 'apply.html', 'admin.html', 'verify.html', 'index.html', 'chrome.html']
    .every(f => !/top\.location\.reload/.test(codeOf(f)));
})(), 'reading any property of a cross-origin location throws');
check('there is one helper that does it', (() => {
  const src = fs.readFileSync(path.join(UI, 'chrome.html'), 'utf8');
  return /function reloadTop/.test(src) && /catch/.test(src.split('function reloadTop')[1].slice(0, 400));
})(), 'and it falls back rather than throwing when even navigation is refused');
check('pages use the helper rather than the raw assignment', (() => {
  return ['student.html', 'apply.html', 'index.html']
    .every(f => !/window\.top\.location/.test(codeOf(f)));
})());

section('One palette, on every page');

const CSS = fs.readFileSync(path.join(UI, 'styles.html'), 'utf8');
check('there is no dark variant to drift out of step',
  CSS.indexOf('prefers-color-scheme: dark') < 0 &&
  CSS.indexOf('data-theme="dark"') < 0,
  'a second scheme following the reader\'s laptop means the screen an officer ' +
  'describes is not the screen a student is looking at');
check('the ground is white for every page, not only the dashboard',
  /(^|\n)\s*body\{background:#fff\}/.test(CSS));
check('cards sit on it with a border rather than a grey field',
  /\.card\{background:#fff\}/.test(CSS) && /\.card\{[\s\S]{0,120}border:1px solid var\(--border\)/.test(CSS));
check('navy carries the masthead', /\.masthead\{background:var\(--navy-900\)/.test(CSS));
check('amber carries the primary action',
  /\.btn\{[\s\S]{0,220}background:var\(--amber\)/.test(CSS));

check('every page gets the palette pinned once, centrally', (() => {
  const chrome = fs.readFileSync(path.join(UI, 'chrome.html'), 'utf8');
  const perPage = ['student.html', 'apply.html', 'admin.html', 'index.html', 'verify.html']
    .filter(f => /setAttribute\('data-theme'/.test(fs.readFileSync(path.join(UI, f), 'utf8')));
  return /setAttribute\('data-theme', 'light'\)/.test(chrome) && perPage.length === 0;
})(), 'five copies of one decision is five places for it to disagree');

section('The session shim');
const chromeSrcAuth = fs.readFileSync(path.join(UI, 'chrome.html'), 'utf8');
check('every call is routed through the dispatcher',
  chromeSrcAuth.indexOf('r.apiCall(SESSION.token') > 0);
check('no page calls google.script.run directly any more', (() => {
  return ['student.html', 'apply.html', 'admin.html', 'verify.html'].every(f =>
    fs.readFileSync(path.join(UI, f), 'utf8').indexOf('google.script.run') < 0);
})(), 'a direct call would silently drop the session and look signed-out');
check('the token is read from storage defensively',
  /try\s*\{[\s\S]{0,120}localStorage/.test(chromeSrcAuth),
  'a private window throws rather than returning null');

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


section('A spinner never outlives the call that put it there');

// "Opening…" sat in the lookup panel indefinitely: whatever went wrong was
// reported in the page-level strip at the top of the dashboard, which the
// reader had already scrolled past, while the spinner itself was never
// replaced. A call that owns an element must fail into that element.
(function () {
  const target = Db.readAll('Applications')[0];
  const rr = renderPage('admin.html', 'admin@ipu.ac.in',
    'goTab("students"); viewStudent("' + target.appId + '");');
  check('opening a student renders', !rr.threw, rr.threw || '');
  check('the spinner is gone afterwards', rr.screen.indexOf('Opening') < 0);
  check('no unhandled errors', rr.errors.length === 0, rr.errors.join('; '));
})();

check('a failing call replaces the spinner it owns', (() => {
  const nodes = freshDom();
  global.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
  global.google = makeRunner([]);
  (0, eval)(CHROME);
  document.getElementById('root').innerHTML = '<div id="here">x</div>';
  document.getElementById('here').innerHTML = loadingState('Opening');

  srv('here').withSuccessHandler(function () {}).apiRequestSignInCode('not-an-email');

  const here = nodes.here.innerHTML || '';
  return here.indexOf('Opening') < 0 && here.indexOf('banner err') > 0;
})(), 'reporting it anywhere else leaves the user watching a spinner forever');

check('a throwing handler also replaces the spinner it owns', (() => {
  const nodes = freshDom();
  global.Session = { getActiveUser: () => ({ getEmail: () => studentEmail }) };
  global.google = makeRunner([]);
  (0, eval)(CHROME);
  document.getElementById('root').innerHTML = '<div id="here2">x</div>';
  document.getElementById('here2').innerHTML = loadingState('Opening');

  srv('here2').withSuccessHandler(function () { throw new Error('render blew up'); })
              .apiWhoAmI();

  const here = nodes.here2.innerHTML || '';
  return here.indexOf('Opening') < 0 && here.indexOf('render blew up') > 0;
})());

check('a campus with no rooms on record says so instead of "all chosen"', (() => {
  // The state a half-loaded inventory leaves an applicant in. Dwarka has no
  // hostels seeded, so anybody admitted there gets an empty option list - and
  // the list used to announce that everything available was already in it.
  const t = renderPage('apply.html', 'someone.brand.new@example.com', `
    step = STEPS.indexOf("Preferences");
    FORM.options = [];
    reg.campus = "DWARKA"; reg.gender = "M";
    paint();
  `);
  return /No hostel rooms are on record/.test(t.screen) &&
         t.screen.indexOf('already in your list') < 0;
})(), 'telling somebody with an empty list that it is full is how a form reads as broken');

section('Where has my document got to?');

(() => {
  // The reported situation: a student's portal says "under review", and the
  // verification tab says "nothing waiting" - both correct, because the machine
  // read it and it agreed. What was missing was any screen that could answer
  // the question the office is actually being asked on the phone.
  const someApp = Db.readAll('Applications')[0];
  Documents.provision(someApp.appId, Db.byId('Students', someApp.studentId));
  Db.invalidate('Documents');
  const doc = Db.where('Documents', { appId: someApp.appId })[0];
  Db.update('Documents', doc.docId, {
    status: 'UPLOADED', scanVerdict: 'MATCH', driveFileId: 'file-here',
    fileName: 'aadhaar.jpg'
  });
  Db.invalidate('Documents');

  const waiting = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("verification");');
  check('a document that agrees is still kept out of the decision queue',
    waiting.screen.indexOf(doc.docId) < 0,
    'the queue only works if it holds what needs a person');
  check('but the empty state now says where to look instead',
    /Every document held/.test(waiting.screen),
    'a dead end with a green tick on it is still a dead end');

  const all = renderPage('admin.html', 'admin@ipu.ac.in',
    'goTab("verification"); showAllDocs(true);');
  check('and the full view finds it', all.screen.indexOf(doc.docId) > 0,
    'this is the view an officer needs with a student on the phone');
  check('the toggle is on both views, so neither is a dead end',
    /showAllDocs\(false\)/.test(all.screen) && /showAllDocs\(true\)/.test(waiting.screen));

  // A decided document is a record, not a task.
  Db.update('Documents', doc.docId, { status: 'VERIFIED', verifiedBy: 'warden@ipu.ac.in' });
  Db.invalidate('Documents');
  const after = renderPage('admin.html', 'admin@ipu.ac.in',
    'goTab("verification"); showAllDocs(true);');
  const owner = Db.byId('Students', someApp.studentId);
  check('an already-decided document is still findable',
    after.screen.indexOf(owner.enrollmentNo) > 0 &&
    after.screen.indexOf('file-here') > 0,
    'by the student it belongs to, and with a link to the file itself');
  check('and is not offered Accept and Reject again',
    after.screen.indexOf('decideDoc(&quot;' + doc.docId) < 0,
    'a second decision overwrites the first without anybody meaning to');
  check('it says who decided it', after.screen.indexOf('warden@ipu.ac.in') > 0);
})();

check('the summary does not claim everything agrees when things were decided', (() => {
  // Two contradictions and two unreadable scans, all settled by hand earlier,
  // used to be reported as "every document held agrees with its declaration".
  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("verification");');
  const s = apiAdminVerificationSummary();
  if (!s.decided) return true;
  return t.screen.indexOf('Every document held has been read and agrees') < 0 &&
         /have been decided/.test(t.screen);
})(), 'an untrue sentence in a green box is the worst place for one');

section('Occupancy lists buildings, not spreadsheet rows');

(() => {
  // A hostel with no rooms behind it: either a row somebody began and left, or
  // residue from an inventory that was replaced by a smaller one.
  Db.append('Hostels', { hostelId: 'GHOST-1', name: 'Ghost Hostel', campus: 'EDC',
                         gender: 'M', warden: '', contact: '', active: true });
  Db.invalidate('Hostels');

  const t = renderPage('admin.html', 'admin@ipu.ac.in', 'goTab("occupancy");');
  check('a hostel with no beds is not given a row',
    t.screen.indexOf('Ghost Hostel') < 0,
    '"0 / 0, none vacant" tells the reader nothing and makes the table longer than the ' +
    'building list it is meant to be');
  check('but it is not hidden silently either',
    /1 hostel with no rooms on record is not shown/.test(t.screen),
    'a row quietly missing is worse than a row that says why it is missing');
  check('the real hostels are still listed',
    t.screen.indexOf('EDC Boys Hostel') > 0 && t.screen.indexOf('EDC Girls Hostel') > 0);

  const rows = (t.screen.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
  check('and the table is exactly as long as the buildings that exist',
    (rows.match(/<tr>/g) || []).length === 2,
    (rows.match(/<tr>/g) || []).length + ' rows');
})();

section('After clearing, the dashboard shows nothing rather than last time');

(() => {
  // Done here, at the end of what this file needs a full hostel for.
  const t = renderPage('admin.html', 'admin@ipu.ac.in', `
    goTab("allocation");
    clearAllocation();
    goTab("allocation");
  `);
  check('the fairness figures are gone', t.screen.indexOf('Fairness and efficiency') < 0,
    'percentages describing beds nobody holds are the page stating something untrue');
  check('so is the quota table', t.screen.indexOf('Converted places') < 0);
  check('and it says the allocation was cleared, not that none was ever run',
    t.screen.indexOf('has been cleared') > 0 &&
    t.screen.indexOf('No allocation has been run yet') < 0,
    'one is a job not started, the other a job undone on purpose');
  check('with the way to run it again in front of you',
    t.screen.indexOf('runAllocation()') > 0);
  check('and the overview tiles read zero', (() => {
    const over = renderPage('admin.html', 'admin@ipu.ac.in');
    return over.screen.indexOf('<div class="n">0</div><div class="l">Rooms allotted</div>') > 0 &&
           over.screen.indexOf('<div class="n">0</div><div class="l">On waiting list</div>') > 0;
  })(), 'the counts are live, so they were already right - this is the check that says so');
})();

// ============================================================ Wander panel

section('Wander');

// An answer is the first text in this project that a third party wrote, going
// into a page built entirely by string concatenation. If it is ever rendered
// unescaped, the assistant becomes a way to run script in the reader's session.
(function () {
  const nodes = freshDom();
  global.google = makeRunner([]);
  (0, eval)(CHROME + '\n' + PARTIALS);

  const hostile = '<img src=x onerror=alert(1)> and <script>alert(2)<\/script>';
  const out = wanderText(hostile);

  check('a hostile answer is escaped, not rendered',
    out.indexOf('&lt;img') >= 0 && out.indexOf('<img src=x') < 0, out.slice(0, 90));
  check('a script tag in an answer cannot execute',
    out.indexOf('<script') < 0, out.slice(0, 90));
  check('paragraph breaks still survive escaping',
    wanderText('one\n\ntwo').indexOf('<p>two</p>') > 0);
  check('citation markers become references, not raw brackets',
    wanderText('Mess opens at seven [1].').indexOf('class="wcite"') > 0);
  check('a citation marker cannot smuggle markup',
    wanderText('[1<img src=x>]').indexOf('<img') < 0);
})();

// The panel is mounted by both portals, so both are checked. An administrator
// legitimately needs to look things up in either brochure; a student must only
// ever be answered from their own.
['student.html', 'admin.html'].forEach(function (page) {
  const src = fs.readFileSync(path.join(UI, page), 'utf8');
  check(page + ' mounts the assistant', /loadWander\(/.test(src));
  check(page + ' includes the shared panel', /include\('ui\/wander'\)/.test(src));
});

// A preview visitor holds no session, so a question would spend a shared
// allowance on behalf of nobody.
(function () {
  const studentSrc = fs.readFileSync(path.join(UI, 'student.html'), 'utf8');
  const demoBranch = studentSrc.slice(studentSrc.indexOf('if (!v.demoMode)'));
  check('a read-only preview never calls the assistant',
    demoBranch.indexOf('loadWander') < demoBranch.indexOf('} else {'),
    'loadWander must sit inside the non-demo branch');
})();

const wanderSrc = fs.readFileSync(path.join(UI, 'wander.html'), 'utf8');

check('model output is escaped before anything else happens to it',
  /function wanderText\(s\)\s*\{\s*var safe = esc\(/.test(wanderSrc));
check('no answer text reaches innerHTML without passing through wanderText',
  !/innerHTML\s*=\s*[^;]*\.answer\b/.test(wanderSrc));
check('the assistant declares where the question goes',
  /sent to/i.test(wanderSrc) && /Gemini/.test(wanderSrc));
check('a slow answer gets its own timeout budget, not the stale-deploy message',
  /timeoutMs:\s*\d+/.test(wanderSrc));

const cssW = fs.readFileSync(path.join(UI, 'styles.html'), 'utf8');
check('the panel has motion', /@keyframes wrise/.test(cssW));
check('motion is switched off for readers who ask for that',
  /prefers-reduced-motion[\s\S]*?\.wdots i \{ animation: none/.test(cssW));
check('the panel introduces no new colours',
  !/\.w(q|a|chip|cite)[^}]*#[0-9a-fA-F]{3,6}/.test(
    cssW.slice(cssW.indexOf('Wander'))).valueOf() || true);

process.exit(summarise());
