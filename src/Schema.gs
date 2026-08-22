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
      { name: 'category',      type: T.ENUM, values: ['reservation', 'eligibility', 'weight', 'capacity', 'roommate'] },
      { name: 'key',           type: T.STR },
      { name: 'value',         type: T.NUM },
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
      { name: 'programme',     type: T.ENUM, values: ['BTech', 'MTech', 'MBA', 'LLB', 'MCA', 'BBA', 'BCA'] },
      { name: 'branch',        type: T.STR },
      // Campus is fixed at admission, not chosen at application time. A student
      // admitted to Dwarka can only be housed in a Dwarka hostel, so this is a
      // hard partition of the allocation alongside gender. See Allocator stage A.
      { name: 'campus',        type: T.ENUM, values: ['DWARKA', 'EDC'] },
      { name: 'year',          type: T.INT },
      { name: 'cgpa',          type: T.NUM },
      // First-year applicants have no CGPA yet, so they are ranked on the
      // entrance rank that admitted them. See Allocator stage B.
      { name: 'entranceRank',  type: T.INT },
      { name: 'meritRank',     type: T.INT },
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
      { name: 'roomType', type: T.ENUM, values: ['SINGLE', 'DOUBLE', 'TRIPLE'] }
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
      { name: 'roomType',     type: T.ENUM, values: ['SINGLE', 'DOUBLE', 'TRIPLE'] },
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
      { name: 'status',      type: T.ENUM, values: ['ACTIVE', 'SUPERSEDED', 'CANCELLED'] }
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
      { name: 'docType',    type: T.ENUM, values: ['ADMISSION_LETTER', 'ID_CARD', 'CATEGORY_CERT', 'PWD_CERT', 'ADDRESS_PROOF'] },
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
  }
};

/** Ordered tab names - controls sheet order in the spreadsheet. */
var SHEET_ORDER = [
  'Config', 'Policy', 'Admins',
  'Students', 'Applications', 'Preferences', 'Lifestyle',
  'Hostels', 'Rooms', 'Beds',
  'Runs', 'Allocations', 'Waitlist',
  'Transfers', 'Grievances', 'Documents', 'Identity',
  'AuditLog', 'PincodeGeo', 'Notifications'
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
