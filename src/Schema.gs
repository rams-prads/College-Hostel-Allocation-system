/**
 * Schema.gs - THE TEAM CONTRACT.
 *
 * Single source of truth for every sheet in the database. Setup.gs builds the
 * spreadsheet from this, Db.gs reads and writes through it, and every other file
 * addresses columns by NAME, never by index.
 *
 * Changing anything here means telling the whole team. See PROJECT_CONTEXT.md section 6.
 */

// Column type tags drive validation and coercion in Db.gs.
var T = {
  STR:  'string',
  NUM:  'number',
  INT:  'integer',
  BOOL: 'boolean',
  DATE: 'datetime',
  JSON: 'json',
  ENUM: 'enum'
};

var SCHEMA = {

  Config: {
    desc: 'Runtime settings, editable by admin without touching code.',
    pk: 'key',
    cols: [
      { name: 'key',   type: T.STR },
      { name: 'value', type: T.STR },
      { name: 'notes', type: T.STR }
    ]
  },

  Policy: {
    desc: 'Allocation rules as DATA, not code. The admin team edits this sheet directly.',
    pk: 'ruleId',
    cols: [
      { name: 'ruleId',        type: T.STR },
      // Every category a rule may belong to. The sheet gets a dropdown built
      // from this list and REFUSES anything else, so adding a category here and
      // nowhere else is not enough - existing sheets carry the old dropdown and
      // must have it refreshed. See repairValidation().
      { name: 'category',      type: T.ENUM,
        values: ['reservation', 'eligibility', 'weight', 'capacity', 'roommate', 'identity',
                 'priority', 'chatbot'] },
      { name: 'key',           type: T.STR },
      // Text, not a number, even though nearly every rule is numeric.
      //
      // Db.decode coerces a T.NUM column with Number() before anything else
      // sees it, which turned the one non-numeric rule - the enrolment-number
      // pattern - into NaN on the way out of the sheet. Policy.load converts
      // numeric-looking values back to numbers, so the arithmetic rules are
      // unaffected and a rule that is a pattern survives being one.
      { name: 'value',         type: T.STR },
      { name: 'effectiveFrom', type: T.DATE },
      { name: 'active',        type: T.BOOL },
      { name: 'notes',         type: T.STR }
    ]
  },

  Students: {
    desc: 'Student master registry.',
    pk: 'studentId',
    cols: [
      { name: 'studentId',     type: T.STR },
      { name: 'name',          type: T.STR },
      { name: 'enrollmentNo',  type: T.STR },
      { name: 'email',         type: T.STR },
      { name: 'phone',         type: T.STR },
      { name: 'dob',           type: T.STR },
      { name: 'gender',        type: T.ENUM, values: ['M', 'F', 'O'] },
      // Text, not a dropdown. The course list lives in Catalogue.gs and changes
      // when the university changes it; a dropdown baked into the sheet would
      // be a second copy that has to be hand-synced and will not be. Validity
      // is checked against the catalogue where a programme is accepted.
      { name: 'programme',     type: T.STR },
      { name: 'branch',        type: T.STR },
      // Campus is fixed at admission, not chosen at application time. A student
      // admitted to Dwarka can only be housed in a Dwarka hostel, so this is a
      // hard partition of the allocation alongside gender. See Allocator stage A.
      { name: 'campus',        type: T.ENUM, values: ['DWARKA', 'EDC'] },
      { name: 'year',          type: T.INT },
      // Which University School of Studies. The brochure restricts hostel
      // eligibility to regular full-time students of the schools on that campus.
      { name: 'school',        type: T.STR },

      // THE field the allotment policy turns on. The brochure's priority order
      // is: disabled first, then OUTSIDE DELHI candidates on merit, then Delhi
      // candidates whose parents were transferred out of Delhi, then remaining
      // Delhi candidates by distance. This is an admission category recorded at
      // entry to the university - it is not derived from the address, and a
      // student living far away is not automatically "outside Delhi".
      { name: 'residenceCategory', type: T.ENUM, values: ['DELHI', 'OUTSIDE_DELHI'] },
      // Delhi-category applicant whose parent has been transferred out of Delhi
      // (Central/State Govt, PSU or autonomous body only). Third priority, and
      // it needs the transfer certificate to be claimed.
      { name: 'parentTransferred', type: T.BOOL },
      // Foreign students draw on a separate 5% of seats, spread evenly across
      // the schools so no one school absorbs the whole allowance.
      { name: 'isForeign',     type: T.BOOL },

      // Merit, as the brochure defines it: the result up to the preceding
      // semester, or - for a first-year with no university result yet - the
      // best five subjects of class 12. Both are percentages, so unlike a CGPA
      // and an entrance rank they sit on one scale and need no normalising.
      { name: 'meritPercent',  type: T.NUM },
      { name: 'meritBasis',    type: T.ENUM, values: ['CLASS_12', 'SEMESTER', 'NOT_RECORDED'] },
      { name: 'meritRank',     type: T.INT },

      // Re-admission conditions, which apply only to a returning resident.
      { name: 'exResident',    type: T.BOOL },
      { name: 'promoted',      type: T.BOOL },
      { name: 'detained',      type: T.BOOL },
      { name: 'disciplinaryFlag', type: T.BOOL },
      { name: 'attendancePct', type: T.NUM },
      // The session they first took a hostel seat in. The fee schedule differs
      // by intake year, so a 2023-24 entrant pays a different rate to a new one.
      { name: 'firstAdmittedSession', type: T.STR },

      { name: 'category',      type: T.ENUM, values: ['GEN', 'OBC', 'SC', 'ST', 'EWS'] },
      { name: 'isPwD',         type: T.BOOL },
      { name: 'pwdType',       type: T.STR },
      { name: 'homeAddress',   type: T.STR },
      { name: 'homeCity',      type: T.STR },
      { name: 'homePincode',   type: T.STR },
      { name: 'homeState',     type: T.STR },
      { name: 'guardianName',  type: T.STR },
      { name: 'guardianPhone', type: T.STR },
      { name: 'guardianEmail', type: T.STR },
      { name: 'bloodGroup',    type: T.STR },
      { name: 'medicalNotes',  type: T.STR },
      // Self-registered records are unverified until documents are checked.
      { name: 'selfDeclared',  type: T.BOOL },
      { name: 'registeredAt',  type: T.DATE }
    ]
  },

  Applications: {
    desc: 'One row per hostel application. The spine of the lifecycle.',
    pk: 'appId',
    cols: [
      { name: 'appId',            type: T.STR },
      { name: 'studentId',        type: T.STR },
      // Mirrored from the student record so the allocator and every report can
      // partition by campus without a join. NOT a preference - see Students.campus.
      { name: 'campus',           type: T.ENUM, values: ['DWARKA', 'EDC'] },
      // The brochure runs two intakes with different windows, documents and
      // fees. Re-admission of existing residents closes BEFORE fresh allotment
      // opens, which is why it is a separate stream and not a flag on a form.
      { name: 'admissionType',    type: T.ENUM, values: ['FRESH', 'READMISSION'] },
      // Which priority group this applicant was placed in, recorded so the
      // decision can be read back months later. See Allocator stage C.
      { name: 'priorityTier',     type: T.ENUM,
        values: ['', 'PWD', 'OUTSIDE_DELHI', 'PARENT_TRANSFERRED', 'DELHI', 'FOREIGN', 'READMISSION'] },
      { name: 'status',           type: T.ENUM, values: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'ALLOTTED', 'WAITLISTED', 'WITHDRAWN', 'CANCELLED'] },
      { name: 'submittedAt',      type: T.DATE },
      { name: 'meritScore',       type: T.NUM },
      { name: 'distanceKm',       type: T.NUM },
      { name: 'eligible',         type: T.BOOL },
      { name: 'eligibilityNotes', type: T.JSON },
      { name: 'docStatus',        type: T.ENUM, values: ['PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED'] },
      { name: 'docFolderUrl',     type: T.STR },
      { name: 'needsAccessible',  type: T.BOOL },
      { name: 'updatedAt',        type: T.DATE }
    ]
  },

  Preferences: {
    desc: 'Ranked hostel/room-type preferences. Long format: one row per rank.',
    pk: null,
    cols: [
      { name: 'appId',    type: T.STR },
      { name: 'rank',     type: T.INT },
      { name: 'hostelId', type: T.STR },
      { name: 'roomType', type: T.ENUM, values: ['SINGLE', 'TRIPLE', 'QUAD'] }
    ]
  },

  Lifestyle: {
    desc: 'Roommate compatibility survey. Feeds Roommate.gs scoring.',
    pk: 'appId',
    cols: [
      { name: 'appId',            type: T.STR },
      { name: 'sleepTime',        type: T.ENUM, values: ['EARLY', 'MODERATE', 'LATE'] },
      { name: 'wakeTime',         type: T.ENUM, values: ['EARLY', 'MODERATE', 'LATE'] },
      { name: 'studyStyle',       type: T.ENUM, values: ['QUIET', 'MUSIC', 'GROUP'] },
      { name: 'cleanliness',      type: T.INT },
      { name: 'sociability',      type: T.INT },
      { name: 'foodPref',         type: T.ENUM, values: ['VEG', 'NONVEG', 'EGG'] },
      { name: 'language',         type: T.STR },
      { name: 'guestsFrequency',  type: T.ENUM, values: ['NEVER', 'SOMETIMES', 'OFTEN'] }
    ]
  },

  Hostels: {
    desc: 'Hostel master across both campuses.',
    pk: 'hostelId',
    cols: [
      { name: 'hostelId', type: T.STR },
      { name: 'name',     type: T.STR },
      { name: 'campus',   type: T.ENUM, values: ['DWARKA', 'EDC'] },
      { name: 'gender',   type: T.ENUM, values: ['M', 'F', 'CO'] },
      { name: 'warden',   type: T.STR },
      { name: 'contact',  type: T.STR },
      { name: 'active',   type: T.BOOL }
    ]
  },

  Rooms: {
    desc: 'Room inventory.',
    pk: 'roomId',
    cols: [
      { name: 'roomId',       type: T.STR },
      { name: 'hostelId',     type: T.STR },
      { name: 'block',        type: T.STR },
      { name: 'floor',        type: T.INT },
      { name: 'roomNo',       type: T.STR },
      { name: 'capacity',     type: T.INT },
      // The EDC brochure lists single, triple and four-seater rooms. There is
      // no two-seater, and a single room is reserved for PG and PhD students.
      { name: 'roomType',     type: T.ENUM, values: ['SINGLE', 'TRIPLE', 'QUAD'] },
      { name: 'isAccessible', type: T.BOOL },
      { name: 'status',       type: T.ENUM, values: ['ACTIVE', 'MAINTENANCE', 'BLOCKED'] }
    ]
  },

  Beds: {
    desc: 'Bed-level inventory. THE atomic allocatable unit - see PROJECT_CONTEXT.md section 6.',
    pk: 'bedId',
    cols: [
      { name: 'bedId',         type: T.STR },
      { name: 'roomId',        type: T.STR },
      { name: 'bedNo',         type: T.INT },
      { name: 'status',        type: T.ENUM, values: ['VACANT', 'OCCUPIED', 'RESERVED', 'BLOCKED'] },
      { name: 'occupantAppId', type: T.STR }
    ]
  },

  Allocations: {
    desc: 'Allocation results. reasonCodes IS the explainability feature.',
    pk: 'allocId',
    cols: [
      { name: 'allocId',     type: T.STR },
      { name: 'runId',       type: T.STR },
      { name: 'appId',       type: T.STR },
      { name: 'bedId',       type: T.STR },
      { name: 'allocatedAt', type: T.DATE },
      { name: 'prefRankMet', type: T.INT },
      { name: 'quotaUsed',   type: T.STR },
      { name: 'reasonCodes', type: T.JSON },
      { name: 'compatScore', type: T.NUM },
      { name: 'status',      type: T.ENUM, values: ['ACTIVE', 'SUPERSEDED', 'CANCELLED'] },
      // Appended. Where the generated letter ended up, so a second press of
      // "generate" skips it instead of building the whole file again.
      { name: 'letterUrl',   type: T.STR },
      { name: 'letterAt',    type: T.DATE }
    ]
  },

  Waitlist: {
    desc: 'Ordered queue for unallocated applicants, with ETA prediction.',
    pk: null,
    cols: [
      { name: 'runId',          type: T.STR },
      { name: 'appId',          type: T.STR },
      { name: 'hostelId',       type: T.STR },
      { name: 'position',       type: T.INT },
      { name: 'etaProbability', type: T.NUM },
      { name: 'reasonCodes',    type: T.JSON },
      { name: 'updatedAt',      type: T.DATE }
    ]
  },

  Transfers: {
    desc: 'Transfer and mutual-swap requests.',
    pk: 'reqId',
    cols: [
      { name: 'reqId',            type: T.STR },
      { name: 'type',             type: T.ENUM, values: ['SWAP', 'TRANSFER', 'UPGRADE'] },
      { name: 'appId',            type: T.STR },
      { name: 'counterpartAppId', type: T.STR },
      { name: 'targetHostelId',   type: T.STR },
      { name: 'status',           type: T.ENUM, values: ['OPEN', 'MATCHED', 'CONSENTED', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      { name: 'policyCheck',      type: T.JSON },
      { name: 'reason',           type: T.STR },
      { name: 'createdAt',        type: T.DATE },
      { name: 'decidedAt',        type: T.DATE }
    ]
  },

  Grievances: {
    desc: 'Grievance tickets. Allocation disputes are auto-answered from the trace.',
    pk: 'ticketId',
    cols: [
      { name: 'ticketId',   type: T.STR },
      { name: 'appId',      type: T.STR },
      { name: 'category',   type: T.ENUM, values: ['ALLOCATION', 'ROOMMATE', 'FACILITY', 'FEE', 'DOCUMENT', 'OTHER'] },
      { name: 'text',       type: T.STR },
      { name: 'autoTriage', type: T.JSON },
      { name: 'status',     type: T.ENUM, values: ['OPEN', 'AUTO_ANSWERED', 'ESCALATED', 'RESOLVED', 'CLOSED'] },
      { name: 'resolution', type: T.STR },
      { name: 'createdAt',  type: T.DATE },
      { name: 'slaDueAt',   type: T.DATE }
    ]
  },

  AuditLog: {
    desc: 'HASH-CHAINED ledger. Each row hashes the previous - tampering is detectable.',
    pk: 'seq',
    cols: [
      { name: 'seq',         type: T.INT },
      { name: 'ts',          type: T.DATE },
      { name: 'actor',       type: T.STR },
      { name: 'action',      type: T.STR },
      { name: 'payloadJson', type: T.JSON },
      { name: 'prevHash',    type: T.STR },
      { name: 'hash',        type: T.STR }
    ]
  },

  Runs: {
    desc: 'Allocation run metadata. Seeded so any run is exactly reproducible.',
    pk: 'runId',
    cols: [
      { name: 'runId',       type: T.STR },
      { name: 'mode',        type: T.ENUM, values: ['DRAFT', 'COMMITTED', 'DISCARDED'] },
      { name: 'seed',        type: T.STR },
      { name: 'policyHash',  type: T.STR },
      { name: 'startedAt',   type: T.DATE },
      { name: 'finishedAt',  type: T.DATE },
      { name: 'triggeredBy', type: T.STR },
      { name: 'metricsJson', type: T.JSON },
      { name: 'notes',       type: T.STR }
    ]
  },

  Admins: {
    desc: 'Role-based access control for the admin dashboard.',
    pk: 'email',
    cols: [
      { name: 'email',  type: T.STR },
      { name: 'name',   type: T.STR },
      { name: 'role',   type: T.ENUM, values: ['SUPER_ADMIN', 'WARDEN', 'VERIFIER', 'VIEWER'] },
      { name: 'campus', type: T.ENUM, values: ['DWARKA', 'EDC', 'ALL'] },
      { name: 'active', type: T.BOOL }
    ]
  },

  PincodeGeo: {
    desc: 'Offline pincode-prefix to lat/lng table. Replaces any paid geocoding API.',
    pk: 'pinPrefix',
    cols: [
      { name: 'pinPrefix', type: T.STR },
      { name: 'lat',       type: T.NUM },
      { name: 'lng',       type: T.NUM },
      { name: 'district',  type: T.STR },
      { name: 'state',     type: T.STR }
    ]
  },

  Documents: {
    desc: 'Per-document verification records. Which documents are required is ' +
          'computed per applicant by Documents.gs, not stored as a fixed list.',
    pk: 'docId',
    cols: [
      { name: 'docId',      type: T.STR },
      { name: 'appId',      type: T.STR },
      // Two documents. The rest of the brochure checklist is collected on paper
      // at the counter; see Documents.gs for why it is not collected twice.
      { name: 'docType',    type: T.ENUM, values: ['AADHAAR', 'ID_CARD'] },
      { name: 'status',     type: T.ENUM, values: ['REQUIRED', 'UPLOADED', 'VERIFIED', 'REJECTED', 'WAIVED'] },
      { name: 'driveFileId',type: T.STR },
      { name: 'fileName',   type: T.STR },
      { name: 'uploadedAt', type: T.DATE },
      { name: 'verifiedBy', type: T.STR },
      { name: 'verifiedAt', type: T.DATE },
      { name: 'note',       type: T.STR },
      // Appended, never inserted. Db reads by column position, so adding a
      // column anywhere but the end would misread every existing row.
      { name: 'mimeType',   type: T.STR },
      { name: 'sizeBytes',  type: T.INT },
      // SHA-256 of the uploaded bytes. Two applications holding a byte-identical
      // document is one of the few decisive fraud signals available offline.
      { name: 'contentHash', type: T.STR },
      // What reading the document said about the declaration. See DocScan.gs.
      { name: 'scanVerdict', type: T.ENUM,
        values: ['UNSCANNED', 'MATCH', 'MINOR', 'CONFLICT', 'UNREADABLE'] },
      { name: 'scanJson',    type: T.JSON },
      { name: 'scannedAt',   type: T.DATE }
    ]
  },

  Identity: {
    desc: 'Identity verification. Aadhaar numbers are NOT stored - only a keyed ' +
          'HMAC reference and the last four digits. See Identity.gs.',
    pk: 'studentId',
    cols: [
      { name: 'studentId',     type: T.STR },
      // HMAC-SHA256 under a key held in Script Properties, never in this sheet.
      // Irreversible, and un-guessable without the key even given the whole file.
      { name: 'aadhaarRef',    type: T.STR },
      { name: 'aadhaarLast4',  type: T.STR },
      { name: 'enrolmentNorm', type: T.STR },
      { name: 'status',        type: T.ENUM, values: ['REQUIRED', 'SUBMITTED', 'VERIFIED', 'REJECTED'] },
      { name: 'riskScore',     type: T.INT },
      { name: 'findingsJson',  type: T.JSON },
      { name: 'submittedAt',   type: T.DATE },
      { name: 'verifiedBy',    type: T.STR },
      { name: 'verifiedAt',    type: T.DATE },
      { name: 'note',          type: T.STR }
    ]
  },

  Notifications: {
    desc: 'Email outbox and delivery log. Respects Gmail free-tier quota.',
    pk: 'msgId',
    cols: [
      { name: 'msgId',    type: T.STR },
      { name: 'appId',    type: T.STR },
      { name: 'toEmail',  type: T.STR },
      { name: 'template', type: T.STR },
      { name: 'subject',  type: T.STR },
      { name: 'status',   type: T.ENUM, values: ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] },
      { name: 'sentAt',   type: T.DATE },
      { name: 'error',    type: T.STR }
    ]
  },

  RuleChunks: {
    desc: 'Retrievable rule text and its embedding. One row per chunk. This is ' +
          'the corpus the assistant is allowed to answer from - nothing else.',
    pk: 'chunkId',
    cols: [
      { name: 'chunkId',   type: T.STR },
      { name: 'source',    type: T.ENUM,
        values: ['BROCHURE', 'POLICY', 'CONFIG', 'ENGINE', 'LETTER'] },
      // What a citation says out loud: 'Boys brochure, rule 12' or 'POL-ELG-ATTN'.
      { name: 'sourceRef', type: T.STR },
      // The two hard partitions, mirrored from the allocator.
      //
      // There is a boys' brochure and a girls' brochure, and their rules differ -
      // fees, timings, wardens. Answering a boy out of the girls' brochure would
      // reintroduce through the assistant exactly what hostelOk_() exists to
      // prevent at the bed level. Empty means the chunk applies to everyone.
      { name: 'gender',    type: T.ENUM, values: ['', 'M', 'F', 'ALL'] },
      { name: 'campus',    type: T.ENUM, values: ['', 'DWARKA', 'EDC', 'ALL'] },
      { name: 'heading',   type: T.STR },
      { name: 'text',      type: T.STR },
      // sha256 prefix of `text`. Re-ingesting re-embeds only what changed, so
      // editing one policy value costs one embedding rather than the corpus.
      { name: 'textHash',  type: T.STR },
      { name: 'dims',      type: T.INT },
      { name: 'scale',     type: T.NUM },
      // base64 of int8, NOT a JSON array of floats. A float32 vector as JSON is
      // ~10KB; at 400 chunks that is 4MB to parse on every single question,
      // which does not fit the budget. See RuleBook.quantise.
      //
      // MUST stay T.STR: refreshColumnRules_ pins T.STR columns to plain-text
      // format. Typed T.JSON the sheet would be free to reinterpret this.
      { name: 'vec',        type: T.STR },
      { name: 'embeddedAt', type: T.DATE },
      { name: 'active',     type: T.BOOL }
    ]
  },

  ChatLog: {
    desc: 'One row per exchange with the assistant. The transcript a student ' +
          'sees on their next visit, and the record of what it answered from.',
    pk: 'turnId',
    cols: [
      { name: 'turnId',    type: T.STR },
      { name: 'appId',     type: T.STR },
      { name: 'studentId', type: T.STR },
      { name: 'askedAt',   type: T.DATE },
      { name: 'question',  type: T.STR },
      { name: 'answer',    type: T.STR },
      { name: 'citations', type: T.JSON },
      // False when nothing cleared the similarity floor, so the assistant said
      // so instead of answering. Worth counting: a corpus with gaps shows up
      // here long before anyone complains.
      { name: 'grounded',  type: T.BOOL },
      { name: 'model',     type: T.STR },
      { name: 'latencyMs', type: T.INT },
      { name: 'status',    type: T.ENUM,
        values: ['ANSWERED', 'REFUSED', 'QUOTA', 'DISABLED', 'ERROR'] },
      { name: 'error',     type: T.STR },
      { name: 'flagged',   type: T.BOOL }
    ]
  }
};

/** Ordered tab names - controls sheet order in the spreadsheet. */
var SHEET_ORDER = [
  'Config', 'Policy', 'Admins',
  'Students', 'Applications', 'Preferences', 'Lifestyle',
  'Hostels', 'Rooms', 'Beds',
  'Runs', 'Allocations', 'Waitlist',
  'Transfers', 'Grievances', 'Documents', 'Identity',
  'AuditLog', 'PincodeGeo', 'Notifications',
  // Appended, never inserted. createDatabase places sheets by ordinal position.
  'RuleChunks', 'ChatLog'
];

/** Column names for a tab, in order. */
function schemaCols(tab) {
  return SCHEMA[tab].cols.map(function (c) { return c.name; });
}

/** 1-based column index of a named column. Throws loudly on typos. */
function schemaColIndex(tab, colName) {
  var i = schemaCols(tab).indexOf(colName);
  if (i < 0) throw new Error('Schema: no column "' + colName + '" in tab "' + tab + '"');
  return i + 1;
}
