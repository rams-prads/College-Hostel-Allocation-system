/**
 * Catalogue.gs - the programmes actually offered, and their sanctioned intake.
 *
 * Taken from the GGSIPU East Delhi Campus course table for 2024-25. Everything
 * that used to be here was invented - a generic BTech/MBA/LLB/MCA mix with made
 * up branches - and inventing a course list for a system that allots seats to
 * the people on those courses meant the demo cohort could not resemble the real
 * one in the way that matters: how many of each there are.
 *
 * The intake figures are the point. A cohort drawn in proportion to sanctioned
 * seats has the right SHAPE - USAR dominates, design and architecture are small,
 * the lateral-entry streams are tiny - and an allocation over it behaves the way
 * the real one will. A cohort drawn from equal weights does not, however
 * realistic each individual record looks.
 *
 * ONE SOURCE. The seeder builds its cohort from this, the registration form
 * offers it, and the single-room rule reads the level from it. A course list
 * that lives in two places is a course list that disagrees with itself.
 *
 * NOT INCLUDED: the Dwarka campus. Its catalogue has not been supplied, and a
 * placeholder here would be the same mistake again. Campus remains a hard
 * partition in the engine; adding Dwarka is an entry in this table and nothing
 * else.
 */

var Catalogue = (function () {

  /**
   * level decides two things: how the single-room rule reads a student, and
   * which year they enter at.
   *
   *   UG          a bachelor's programme, entered at year 1
   *   LATERAL     entered at year 2, on a diploma or a B.Sc
   *   DUAL        B.Tech-M.Tech, five years, postgraduate in the final year
   *   PG          a master's programme
   *   PG_DIPLOMA  a postgraduate diploma
   *   PHD         doctoral
   */
  var PROGRAMMES = [
    {
      code: 'BTMT', name: 'B.Tech-M.Tech (Dual Degree)', school: 'USAR',
      cet: '131', level: 'DUAL', years: 5,
      branches: [
        { name: 'Artificial Intelligence & Data Science',    intake: 120 },
        { name: 'Artificial Intelligence & Machine Learning', intake: 120 },
        { name: 'Industrial Internet of Things',              intake: 120 },
        { name: 'Automation & Robotics',                      intake: 120 }
      ]
    },
    {
      code: 'LE-BTMT', name: 'LE-B.Tech-M.Tech (Dual Degree)', school: 'USAR',
      cet: '128 & 129', level: 'LATERAL', years: 4, entryYear: 2,
      note: 'Lateral entry for diploma holders and B.Sc graduates.',
      branches: [
        { name: 'Artificial Intelligence & Data Science',    intake: 12 },
        { name: 'Artificial Intelligence & Machine Learning', intake: 12 },
        { name: 'Industrial Internet of Things',              intake: 12 },
        { name: 'Automation & Robotics',                      intake: 12 }
      ]
    },
    {
      code: 'PGD-CS', name: 'PG Diploma', school: 'USAR',
      cet: '177', level: 'PG_DIPLOMA', years: 1,
      branches: [
        { name: 'Cyber Security, Cyber Disaster and Block Chain Technology (Weekend Mode)',
          intake: 60 }
      ]
    },
    {
      code: 'BDES', name: 'Bachelor of Design', school: 'USDI',
      cet: '600', level: 'UG', years: 4,
      branches: [
        { name: 'Industrial Design',  intake: 44, ews: 4 },
        { name: 'Interaction Design', intake: 44, ews: 4 },
        { name: 'Interior Design',    intake: 44, ews: 4 }
      ]
    },
    {
      code: 'LE-BDES', name: 'LE-Bachelor of Design', school: 'USDI',
      cet: '613', level: 'LATERAL', years: 3, entryYear: 2,
      branches: [
        { name: 'Design (Lateral Entry Scheme)', intake: 44 }
      ]
    },
    {
      code: 'MDES', name: 'Master of Design', school: 'USDI',
      cet: '611', level: 'PG', years: 2,
      branches: [
        { name: 'Industrial Design / Interior Design / Interaction Design', intake: 49 }
      ]
    },
    {
      code: 'BARCH', name: 'Bachelor of Architecture', school: 'USAP',
      cet: '100', level: 'UG', years: 5,
      branches: [
        { name: 'Architecture', intake: 80 }
      ]
    },
    {
      code: 'MARCH', name: 'Master of Architecture', school: 'USAP',
      cet: '367', level: 'PG', years: 2,
      branches: [
        { name: 'Urban Design', intake: 20, ews: 2 }
      ]
    },
    {
      code: 'MPLAN', name: 'Master of Planning', school: 'USAP',
      cet: '368', level: 'PG', years: 2,
      branches: [
        { name: 'Urban & Regional Planning', intake: 80 }
      ]
    },
    // Doctoral programmes carry no sanctioned intake in the table. They are
    // real, they are few, and a nominal figure keeps them present in a cohort
    // without pretending to a number the university has not published.
    {
      code: 'PHD-USAR', name: 'PhD', school: 'USAR',
      cet: '211/212/213', level: 'PHD', years: 5,
      branches: [
        { name: 'Artificial Intelligence - Data Science / Machine Learning', intake: 6 },
        { name: 'Industrial Internet of Things (IIOT)',                      intake: 4 },
        { name: 'Automation and Robotics (A&R)',                             intake: 4 }
      ]
    },
    {
      code: 'PHD-USDI', name: 'PhD', school: 'USDI',
      cet: '', level: 'PHD', years: 5,
      branches: [{ name: 'Design', intake: 3 }]
    },
    {
      code: 'PHD-USAP', name: 'PhD', school: 'USAP',
      cet: '', level: 'PHD', years: 5,
      branches: [{ name: 'Architecture and Planning', intake: 3 }]
    }
  ];

  var SCHOOL_NAMES = {
    USAR: 'University School of Automation & Robotics',
    USDI: 'University School of Design & Innovation',
    USAP: 'University School of Architecture & Planning'
  };

  /** Every programme, in catalogue order. */
  function programmes() { return PROGRAMMES; }

  function byCode(code) {
    for (var i = 0; i < PROGRAMMES.length; i++) {
      if (PROGRAMMES[i].code === code) return PROGRAMMES[i];
    }
    return null;
  }

  /** The school a programme belongs to - never asked for separately. */
  function schoolOf(code) {
    var p = byCode(code);
    return p ? p.school : '';
  }

  function schools() { return Object.keys(SCHOOL_NAMES); }
  function schoolName(code) { return SCHOOL_NAMES[code] || code || ''; }

  /**
   * Is this student postgraduate, for the single-room rule?
   *
   * A dual-degree student is an undergraduate for four years and a
   * postgraduate in the fifth, when they are on the M.Tech half of it. Treating
   * them as PG throughout would hand first-years single rooms; treating them as
   * UG throughout would deny one to somebody sitting an M.Tech.
   */
  function isPgOrPhd(code, year) {
    var p = byCode(code);
    if (!p) return false;
    if (p.level === 'PG' || p.level === 'PHD' || p.level === 'PG_DIPLOMA') return true;
    if (p.level === 'DUAL') return Number(year) >= 5;
    return false;
  }

  /** Which year a student on this programme starts in. Lateral entry is year 2. */
  function entryYear(code) {
    var p = byCode(code);
    return (p && p.entryYear) || 1;
  }

  function years(code) {
    var p = byCode(code);
    return (p && p.years) || 4;
  }

  function branches(code) {
    var p = byCode(code);
    return p ? p.branches.map(function (b) { return b.name; }) : [];
  }

  /**
   * Weights for drawing a cohort: one entry per (programme, branch), weighted by
   * its sanctioned intake. Drawing uniformly would give design and architecture
   * the same footprint as USAR, which is not the university this serves.
   */
  function intakeWeights() {
    var out = [];
    PROGRAMMES.forEach(function (p) {
      p.branches.forEach(function (b) {
        out.push([p.code + '|' + b.name, b.intake]);
      });
    });
    return out;
  }

  /** Total sanctioned seats across the catalogue, per year of intake. */
  function totalIntake() {
    var n = 0;
    PROGRAMMES.forEach(function (p) {
      p.branches.forEach(function (b) { n += Number(b.intake) || 0; });
    });
    return n;
  }

  return {
    programmes: programmes,
    byCode: byCode,
    schoolOf: schoolOf,
    schools: schools,
    schoolName: schoolName,
    isPgOrPhd: isPgOrPhd,
    entryYear: entryYear,
    years: years,
    branches: branches,
    intakeWeights: intakeWeights,
    totalIntake: totalIntake
  };
})();
