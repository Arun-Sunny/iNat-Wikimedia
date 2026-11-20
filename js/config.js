// App configuration. Everything in this file is public: it is sent to every visitor's browser.
// Never put a password, bot password or client SECRET here. The OAuth client ID is not secret.

export const CONFIG = {
  // Visitors enter their own iNaturalist profile link or username on the page, and the browser
  // remembers it. Leave these empty, or preset an account for a personal deployment.
  inatUser: '',
  // Credit on Commons. Empty means "use the name and profile link from iNaturalist".
  author: {
    name: '',
    url: '',
  },

  defaultEnvironment: 'production',
  environments: {
    production: {
      label: 'Wikimedia Commons',
      commonsApi: 'https://commons.wikimedia.org/w/api.php',
      commonsWiki: 'https://commons.wikimedia.org/wiki/',
      oauthRest: 'https://meta.wikimedia.org/w/rest.php',
      // Paste the OAuth 2.0 client ID ("client application key") here after registering.
      // See README → "Register the Wikimedia login".
      clientId: '',
      structuredData: true,
    },
    beta: {
      label: 'Beta Commons (test site)',
      commonsApi: 'https://commons.wikimedia.beta.wmcloud.org/w/api.php',
      commonsWiki: 'https://commons.wikimedia.beta.wmcloud.org/wiki/',
      oauthRest: 'https://meta.wikimedia.beta.wmcloud.org/w/rest.php',
      clientId: '',
      // The beta cluster's Wikidata uses different item IDs, so structured data is skipped there.
      structuredData: false,
    },
  },

  wikidataSparql: 'https://query.wikidata.org/sparql',

  // Defaults for the Settings panel. Each visitor can change these; they're saved in their browser.
  minQuality: 'research', // research | needs_id | casual
  requireTaxon: true,
  fallbackCategory: 'Media needing categories',
  extraCategory: '', // project/campaign categories, one per line or separated by ;
  editHashtag: '', // e.g. "#WLE2026", appended to every upload's edit summary
  includeLicenseReview: true,
  batchSize: 25, // photos checked per "Check & preview" run
  uploadLimit: 5, // most photos one upload run will send
  uploadDelaySec: 10,

  // Source code and full guide; linked from the app's Help page.
  repoUrl: 'https://github.com/Arun-Sunny/iNat-Wikimedia',

  // Sent to Wikimedia as Api-User-Agent, so Wikimedia can tell what tool is calling and where it lives.
  userAgent: 'iNat-Wikimedia/0.2 (https://github.com/Arun-Sunny/iNat-Wikimedia)',
};
