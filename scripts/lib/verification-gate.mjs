/**
 * X8 / GPC-01.6. `docs/verification.md` says the live gate is required before publishing, and 0.3.0
 * is versioned and dated as a release while its own live line still reads "not run". A sentence in a
 * document cannot block a publish; this can. `GROK_PLUGIN_RELEASE=1 npm run validate:plugin` fails
 * until the file carries a dated live line, for the version in package.json, naming the Grok CLI
 * version `npm run smoke:live-grok` ran against.
 *
 * The offline gate cannot stand in for it: it observes no Grok CLI at all, and the 0.2.1 stop-reason
 * regression that this release fixes passed every offline gate for a month.
 */

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const CLI_VERSION = /\bGrok CLI \d+\.\d+\.\d+/;
const NOT_RUN = /\bnot run\b/i;

/**
 * The paragraph introduced by `<label>` — records wrap, so a single line is not the unit. The label
 * must open a line, so a mention inside a sentence or an indented example cannot pass for a record.
 */
export function gateParagraph(text, label) {
  const opener = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  const start = text.search(opener);
  if (start === -1) return undefined;
  const end = text.indexOf("\n\n", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/**
 * @param {string} text        contents of docs/verification.md
 * @param {string} version     the version being validated (package.json)
 * @param {{ release?: boolean }} [options]
 * @returns {string[]} validation errors, empty when the records are acceptable
 */
export function checkVerificationRecords(text, version, options = {}) {
  const release = options.release === true;
  const errors = [];
  const offlineLabel = `Offline gate, ${version}:`;
  const liveLabel = `Live gate, ${version}:`;
  const offline = gateParagraph(text, offlineLabel);
  const live = gateParagraph(text, liveLabel);

  if (!offline) {
    errors.push(`docs/verification.md must record "${offlineLabel} …" for the current version`);
  } else if (!ISO_DATE.test(offline)) {
    errors.push(`docs/verification.md "${offlineLabel}" must carry a YYYY-MM-DD date`);
  }

  if (!live) {
    errors.push(`docs/verification.md must record "${liveLabel} …" for the current version`);
    return errors;
  }
  // Outside a release build the live record may legitimately say "not run": that is the honest
  // state of a branch under development, and it is what this gate refuses to publish.
  if (!release) return errors;

  if (NOT_RUN.test(live)) {
    errors.push(
      `release blocked: the live gate for ${version} is recorded as "not run" — run \`npm run smoke:live-grok\` ` +
        `and replace that record with a dated line naming the Grok CLI version it ran against`
    );
    return errors;
  }
  if (!ISO_DATE.test(live)) {
    errors.push(`release blocked: "${liveLabel}" must carry the YYYY-MM-DD date the live gate ran`);
  }
  if (!CLI_VERSION.test(live)) {
    errors.push(`release blocked: "${liveLabel}" must name the CLI version it ran against, as "Grok CLI <x.y.z>"`);
  }
  return errors;
}
