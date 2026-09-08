#!/usr/bin/env node
// Verify reference/issue-mapping.json against the checklist it maps from, the
// catalog it maps to, and the skill files that consume it.
//
// The mapping is hand-written, and its whole value is that every string in it is
// one an auditor can paste into Add Manual Issue. A mapping to an entry that does
// not exist files nothing; a mapping to the wrong entry files a wrong issue on a
// real audit. So every option text is matched verbatim against the dump, and
// every checklist branch against the mapping.
//
// The unit is the branch, not the slug. Eleven slugs are cited by two checklist
// branches: nine resolve by success criterion (byCriterion), and two — dual-role
// and semantic-data-table — are cited twice under one criterion by branches that
// mean different things, so they resolve by branch name (byBranch).
//
// The skill-file pass closes the other half of the loop. A skill file names its
// catalog entry by full option text, inline, and records the mapping row it came
// from in an HTML comment. Both directions are checked: an option text no
// mapping row sanctions is a branch nobody reviewed, and an audit trail naming a
// row that does not exist is a citation that has rotted.
//
// Usage: node tools/check-issue-mapping.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// src/tools/<file> -> the repository root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKLIST = join(root, 'reference/page-state-tests.json');
const MAPPING = join(root, 'reference/issue-mapping.json');
const CATALOG = join(root, 'build/manual-issue/catalog.json');
const SKILLS = join(root, 'skills');
const CONFIDENCES = ['high', 'low', 'unmapped'];

// A catalog option text always ends in its parenthesised ids: one WCAG instance
// id, then any number of RGAA mappings. That shape is how a citation is found in
// a skill file regardless of whether it sits in a tool call, a routing table or
// an authoring comment.
const OPTION_TEXT_SHAPE = /\(\d+\.\d+\.\d+\.[a-z](?:,\s*rgaa-[\d.]+)*\)$/;
const QUOTED = /"([^"\n]+)"/g;
const BACKTICKED = /`([^`\n]+)`/g;
const HTML_COMMENT = /<!--([\s\S]*?)-->/g;
// slug @ criterion / confidence, with an optional #branch qualifier.
const AUDIT_TRAIL = /([a-z][a-z0-9.-]*)(?:#([a-z0-9-]+))?\s*@\s*(\d+\.\d+\.\d+)\s*\/\s*([a-z]+)/g;

const failures = [];
const fail = (message) => failures.push(message);

function load(path, hint) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`cannot read ${relative(root, path)}: ${error.message}`);
    if (hint) console.error(hint);
    process.exit(2);
  }
}

const checklist = load(CHECKLIST);
const mapping = load(MAPPING);
const catalog = load(CATALOG, 'Regenerate it with `make catalog`.');

// Every option text in the catalog, and the entry it belongs to. The full option
// text is the only unique key: the instance id is not, and one label collides.
const byOptionText = new Map(catalog.map((entry) => [entry.optionText, entry]));
if (byOptionText.size !== catalog.length) {
  fail(`catalog holds ${catalog.length} entries but only ${byOptionText.size} distinct option texts`);
}

// What the checklist actually cites. A branch is one issue cited by one check;
// a slug cited by two checks is two branches even when both name one criterion.
const cited = new Map();
for (const test of checklist.tests) {
  for (const check of test.checks ?? []) {
    for (const issue of check.issues ?? []) {
      if (!cited.has(issue.id)) {
        cited.set(issue.id, { criteria: new Set(), tests: new Set(), branches: [] });
      }
      const record = cited.get(issue.id);
      record.criteria.add(issue.sc);
      record.tests.add(test.id);
      record.branches.push({ criterion: issue.sc, when: check.when, test: test.id });
    }
  }
}
const branchTotal = [...cited.values()].reduce((n, record) => n + record.branches.length, 0);

const rows = mapping.mappings ?? {};
for (const slug of cited.keys()) {
  if (!(slug in rows)) fail(`${slug}: cited by the checklist, absent from the mapping`);
}
for (const slug of Object.keys(rows)) {
  if (!cited.has(slug)) fail(`${slug}: mapped but not cited by any page state test`);
}

function checkEntry(slug, where, cell, expectedCriterion) {
  const { catalogOptionText, catalogInstances, confidence, note } = cell;

  if (!CONFIDENCES.includes(confidence)) {
    fail(`${slug}${where}: confidence "${confidence}" is not one of ${CONFIDENCES.join(', ')}`);
  }
  if (confidence !== 'high' && !note) {
    fail(`${slug}${where}: confidence "${confidence}" without a note explaining why`);
  }

  if (confidence === 'unmapped') {
    if (catalogOptionText != null) fail(`${slug}${where}: unmapped rows carry no catalog entry`);
    return confidence;
  }

  const entry = byOptionText.get(catalogOptionText);
  if (!entry) {
    fail(`${slug}${where}: "${catalogOptionText}" appears nowhere in the catalog dump`);
    return confidence;
  }
  if (JSON.stringify(entry.instances) !== JSON.stringify(catalogInstances)) {
    fail(
      `${slug}${where}: catalogInstances ${JSON.stringify(catalogInstances)} does not match the ` +
        `dump's ${JSON.stringify(entry.instances)}`,
    );
  }
  // A high-confidence row must file under the criterion the checklist cites.
  // Where it cannot, that is exactly what a low-confidence note is for.
  const criterionMatches = entry.instances.some((id) => id.startsWith(`${expectedCriterion}.`));
  if (confidence === 'high' && !criterionMatches) {
    fail(
      `${slug}${where}: entry carries ${entry.instances.join(', ')} but the checklist cites ` +
        `${expectedCriterion}; a criterion shift cannot be high confidence`,
    );
  }
  return confidence;
}

const counts = { high: 0, low: 0, unmapped: 0 };
const branchCounts = { high: 0, low: 0, unmapped: 0 };
const usage = new Map();
// optionText -> the branches the mapping sanctions filing it from. The skill-file
// pass reads this: a file may only cite an entry some branch resolves to.
const sanctioned = new Map();
// slug -> every resolvable cell, for the audit-trail pass.
const resolvable = new Map();

function record(slug, label, cell, criterion, tests) {
  resolvable.set(slug, [...(resolvable.get(slug) ?? []), { label, criterion, cell }]);
  if (!cell.catalogOptionText) return;
  usage.set(cell.catalogOptionText, [...(usage.get(cell.catalogOptionText) ?? []), label]);
  sanctioned.set(cell.catalogOptionText, [
    ...(sanctioned.get(cell.catalogOptionText) ?? []),
    { label, tests },
  ]);
}

for (const [slug, cite] of cited) {
  const row = rows[slug];
  if (!row) continue;
  const criteria = [...cite.criteria].sort();
  const where = `${slug}`;

  if (row.slug !== slug) fail(`${where}: row's own slug field reads "${row.slug}"`);

  const declared = Array.isArray(row.successCriterion) ? [...row.successCriterion].sort() : [row.successCriterion];
  if (declared.join() !== criteria.join()) {
    fail(`${where}: successCriterion ${declared.join(', ')} but the checklist cites ${criteria.join(', ')}`);
  }

  const tests = [...cite.tests].sort((a, b) => a - b);
  if ((row.pageStateTests ?? []).join() !== tests.join()) {
    fail(`${where}: pageStateTests ${(row.pageStateTests ?? []).join(', ')} but cited by test ${tests.join(', ')}`);
  }

  const shapes = ['catalogOptionText', 'byCriterion', 'byBranch'].filter((key) => row[key] != null);
  if (shapes.length > 1) fail(`${where}: carries ${shapes.join(' and ')}; a row carries exactly one`);

  const seen = [];
  // Which cell serves each checklist branch. Every branch must land on one.
  const served = new Map();

  if (row.byBranch) {
    const names = Object.keys(row.byBranch);
    const byWhen = new Map();
    for (const name of names) {
      const cell = row.byBranch[name];
      const label = `${slug} #${name}`;
      if (typeof cell.when !== 'string' || !cell.when) {
        fail(`${where} #${name}: branch carries no "when" naming the checklist condition it serves`);
        continue;
      }
      if (byWhen.has(cell.when)) {
        fail(`${where} #${name}: same "when" as branch #${byWhen.get(cell.when)}`);
        continue;
      }
      byWhen.set(cell.when, name);

      const branch = cite.branches.find((candidate) => candidate.when === cell.when);
      if (!branch) {
        fail(`${where} #${name}: "when" matches no checklist branch citing this slug`);
        continue;
      }
      if (cell.successCriterion !== branch.criterion) {
        fail(
          `${where} #${name}: successCriterion ${cell.successCriterion} but the checklist cites ` +
            `${branch.criterion} on that branch`,
        );
      }
      served.set(branch, cell);
      seen.push(checkEntry(slug, ` #${name}`, cell, branch.criterion));
      record(slug, label, cell, branch.criterion, tests);
    }
  } else if (row.byCriterion) {
    if (cite.branches.length !== criteria.length) {
      fail(
        `${where}: cited by ${cite.branches.length} branches under ${criteria.length} criteri` +
          `${criteria.length === 1 ? 'on' : 'a'}, so a criterion cannot select between them; it needs a byBranch row`,
      );
    }
    const keys = Object.keys(row.byCriterion).sort();
    if (keys.join() !== criteria.join()) {
      fail(`${where}: byCriterion covers ${keys.join(', ')} but the checklist cites ${criteria.join(', ')}`);
    }
    for (const criterion of keys) {
      const cell = row.byCriterion[criterion];
      seen.push(checkEntry(slug, ` [${criterion}]`, cell, criterion));
      record(slug, `${slug} [${criterion}]`, cell, criterion, tests);
      for (const branch of cite.branches.filter((candidate) => candidate.criterion === criterion)) {
        served.set(branch, cell);
      }
    }
  } else {
    if (criteria.length !== 1) {
      fail(`${where}: cited under ${criteria.join(', ')}, so it needs a byCriterion row`);
    } else if (cite.branches.length !== 1) {
      fail(
        `${where}: cited by ${cite.branches.length} branches under the one criterion ${criteria[0]}, ` +
          `so it needs a byBranch row`,
      );
    }
    seen.push(checkEntry(slug, '', row, criteria[0]));
    record(slug, slug, row, criteria[0], tests);
    for (const branch of cite.branches) served.set(branch, row);
  }

  // Completeness, per branch: the checklist cites 103, and every one of them has
  // to resolve to an entry an auditor can file.
  for (const branch of cite.branches) {
    const cell = served.get(branch);
    if (!cell) {
      fail(`${where}: no mapping row serves the branch "${branch.when.slice(0, 60)}…" (test ${branch.test}, ${branch.criterion})`);
      continue;
    }
    if (cell.confidence in branchCounts) branchCounts[cell.confidence] += 1;
  }

  const rolled = seen.includes('unmapped') ? 'unmapped' : seen.includes('low') ? 'low' : 'high';
  if (row.confidence !== rolled) {
    fail(`${where}: confidence "${row.confidence}" but its entries roll up to "${rolled}"`);
  }
  if (rolled in counts) counts[rolled] += 1;
}

for (const [key, value] of Object.entries(counts)) {
  if (mapping.counts?.[key] !== value) {
    fail(`counts.${key} reads ${mapping.counts?.[key]}, actual ${value}`);
  }
}
for (const [key, value] of Object.entries(branchCounts)) {
  if (mapping.branchCounts?.[key] !== value) {
    fail(`branchCounts.${key} reads ${mapping.branchCounts?.[key]}, actual ${value}`);
  }
}

// ---------------------------------------------------------------------------
// The skill files.

function markdownUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of entries.sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...markdownUnder(path));
    else if (name.endsWith('.md')) found.push(path);
  }
  return found;
}

function citedOptionTexts(source) {
  const found = new Set();
  for (const pattern of [QUOTED, BACKTICKED]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      if (OPTION_TEXT_SHAPE.test(match[1])) found.add(match[1]);
    }
  }
  return found;
}

function auditTrails(source) {
  const found = [];
  HTML_COMMENT.lastIndex = 0;
  let comment;
  while ((comment = HTML_COMMENT.exec(source)) !== null) {
    AUDIT_TRAIL.lastIndex = 0;
    let trail;
    while ((trail = AUDIT_TRAIL.exec(comment[1])) !== null) {
      found.push({ slug: trail[1], branch: trail[2], criterion: trail[3], confidence: trail[4] });
    }
  }
  return found;
}

const skillFiles = markdownUnder(SKILLS);
let citations = 0;
let trails = 0;

for (const path of skillFiles) {
  const rel = relative(root, path);
  const source = readFileSync(path, 'utf8');
  const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? '';
  const declaredTest = /^test:\s*(\d+)\s*$/m.exec(frontMatter)?.[1];
  const testId = declaredTest == null ? null : Number(declaredTest);

  for (const text of citedOptionTexts(source)) {
    citations += 1;
    if (!byOptionText.has(text)) {
      fail(`${rel}: files "${text}", which appears nowhere in the catalog dump`);
      continue;
    }
    const rowsFiling = sanctioned.get(text);
    if (!rowsFiling) {
      fail(`${rel}: files "${text}" — a real catalog entry, but no mapping row resolves to it`);
      continue;
    }
    if (testId != null && !rowsFiling.some((source_) => source_.tests.includes(testId))) {
      fail(
        `${rel}: files "${text}", which the mapping resolves only for page state test ` +
          `${[...new Set(rowsFiling.flatMap((source_) => source_.tests))].sort((a, b) => a - b).join(', ')}, ` +
          `not ${testId}`,
      );
    }
  }

  for (const trail of auditTrails(source)) {
    trails += 1;
    const cells = resolvable.get(trail.slug);
    if (!cells) {
      fail(`${rel}: audit trail cites "${trail.slug}", which is not a mapping row`);
      continue;
    }
    let candidates = cells.filter((cell) => cell.criterion === trail.criterion);
    if (!candidates.length) {
      fail(
        `${rel}: audit trail cites ${trail.slug} @ ${trail.criterion}, but that row resolves only ` +
          `under ${[...new Set(cells.map((cell) => cell.criterion))].join(', ')}`,
      );
      continue;
    }
    if (trail.branch) {
      candidates = candidates.filter((cell) => cell.label === `${trail.slug} #${trail.branch}`);
      if (!candidates.length) {
        fail(`${rel}: audit trail cites ${trail.slug}#${trail.branch}, which is not a branch of that row`);
        continue;
      }
    }
    if (!candidates.some((cell) => cell.cell.confidence === trail.confidence)) {
      fail(
        `${rel}: audit trail cites ${trail.slug} @ ${trail.criterion} / ${trail.confidence}, but the ` +
          `mapping reads ${[...new Set(candidates.map((cell) => cell.cell.confidence))].join(', ')}`,
      );
    }
  }
}

const shared = [...usage.entries()].filter(([, labels]) => labels.length > 1);

if (failures.length) {
  console.error(`reference/issue-mapping.json: ${failures.length} problem(s)\n`);
  for (const message of failures) console.error(`  ${message}`);
  process.exit(1);
}

console.log(
  `reference/issue-mapping.json: ${branchTotal} branches across ${cited.size} slugs, all resolving ` +
    `to entries in the ${catalog.length}-entry catalog`,
);
console.log(`  by branch: high ${branchCounts.high}   low ${branchCounts.low}   unmapped ${branchCounts.unmapped}`);
console.log(`  by slug:   high ${counts.high}   low ${counts.low}   unmapped ${counts.unmapped}`);
console.log(`  ${usage.size} distinct catalog entries used`);
if (shared.length) {
  console.log(`  ${shared.length} catalog entr${shared.length === 1 ? 'y' : 'ies'} filed by more than one branch:`);
  for (const [text, labels] of shared) console.log(`    ${text}\n      ${labels.join(', ')}`);
}
console.log(
  `skills/: ${skillFiles.length} file(s), ${citations} catalog citation(s) and ${trails} audit trail(s), ` +
    `all sanctioned by the mapping`,
);
