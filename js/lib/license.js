// iNaturalist license codes → Commons license templates and Wikidata items.
//
// iNaturalist publishes its CC licenses as version 4.0 (CC0 is 1.0). Commons accepts only
// CC0, CC BY and CC BY-SA from iNaturalist; NC and ND variants are not free enough, and a
// missing code means "all rights reserved".

const LICENSES = {
  cc0: { code: 'cc0', template: 'Cc-zero', qid: 'Q6938433', label: 'CC0 1.0' },
  'cc-by': { code: 'cc-by', template: 'Cc-by-4.0', qid: 'Q20007257', label: 'CC BY 4.0' },
  'cc-by-sa': { code: 'cc-by-sa', template: 'Cc-by-sa-4.0', qid: 'Q18199165', label: 'CC BY-SA 4.0' },
};

/** Returns the Commons mapping for an iNaturalist license code, or null if Commons can't accept it. */
export function mapLicense(code) {
  if (!code) return null;
  return LICENSES[String(code).trim().toLowerCase()] ?? null;
}

/** The parameter {{self}} expects, e.g. "cc-by-4.0". */
export function selfParam(license) {
  return license.template.toLowerCase();
}
