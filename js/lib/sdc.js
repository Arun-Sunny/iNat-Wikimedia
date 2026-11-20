// Structured data (wbeditentity "data") for a Commons file's MediaInfo entity, M<pageid>.
//
// Properties: depicts P180, creator P170 (somevalue + author name / username / URL qualifiers,
// as UploadWizard does for own work), copyright license P275, copyright status P6216,
// source of file P7482, inception P571, coordinates of the point of view P1259.
import { mapLicense } from './license.js';
import { locationAllowed } from './plan.js';
import { captionText } from './wikitext.js';
import { isIsoDate } from './util.js';

export const QIDS = {
  copyrighted: 'Q50423863',
  originalCreationByUploader: 'Q66458942',
  fileAvailableOnInternet: 'Q74228490',
  iNaturalist: 'Q16958215',
};
const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const EARTH = 'http://www.wikidata.org/entity/Q2';
const CAPTION_MAX = 250;

const itemValue = (qid) => ({
  value: { 'entity-type': 'item', 'numeric-id': Number(qid.slice(1)), id: qid },
  type: 'wikibase-entityid',
});
const stringValue = (s) => ({ value: s, type: 'string' });
const valueSnak = (property, datavalue) => ({ snaktype: 'value', property, datavalue });

function statement(mainsnak, qualifiers) {
  const s = { mainsnak, type: 'statement', rank: 'normal' };
  if (qualifiers && Object.keys(qualifiers).length) {
    s.qualifiers = qualifiers;
    s['qualifiers-order'] = Object.keys(qualifiers);
  }
  return s;
}

/** Wikibase coordinate precision (degrees) from an accuracy radius in metres. */
export function coordPrecision(accuracyMetres) {
  if (!accuracyMetres || accuracyMetres <= 0) return 0.0001;
  const degrees = accuracyMetres / 111320;
  const p = 10 ** Math.floor(Math.log10(degrees));
  return Math.min(1, Math.max(0.000001, p));
}

export function userPageUrl(commonsUser) {
  return `https://commons.wikimedia.org/wiki/User:${encodeURIComponent(commonsUser.replace(/ /g, '_'))}`;
}

/**
 * @param rec photo record
 * @param ctx { authorName, authorUrl, commonsUser, depictsQid, ownWork }
 *   ownWork false = copied from iNaturalist by someone else: the creator is credited by name and
 *   iNaturalist profile only, and the source is "file available on the internet" at the photo page.
 * @returns { labels, claims } ready for wbeditentity's data parameter
 */
export function buildSdc(rec, ctx) {
  const license = mapLicense(rec.licenseCode);
  if (!license) throw new Error(`License "${rec.licenseCode}" can't be uploaded to Commons`);
  const ownWork = ctx.ownWork !== false;
  const claims = [];

  if (ctx.depictsQid) claims.push(statement(valueSnak('P180', itemValue(ctx.depictsQid))));

  const creator = { P2093: [valueSnak('P2093', stringValue(ctx.authorName))] };
  if (ownWork && ctx.commonsUser) {
    creator.P4174 = [valueSnak('P4174', stringValue(ctx.commonsUser))];
    creator.P2699 = [valueSnak('P2699', stringValue(userPageUrl(ctx.commonsUser)))];
  } else {
    creator.P2699 = [valueSnak('P2699', stringValue(ctx.authorUrl))];
  }
  claims.push(statement({ snaktype: 'somevalue', property: 'P170' }, creator));

  claims.push(statement(valueSnak('P275', itemValue(license.qid))));
  claims.push(statement(valueSnak('P6216', itemValue(QIDS.copyrighted))));
  if (ownWork) {
    claims.push(statement(valueSnak('P7482', itemValue(QIDS.originalCreationByUploader))));
  } else {
    claims.push(statement(valueSnak('P7482', itemValue(QIDS.fileAvailableOnInternet)), {
      P973: [valueSnak('P973', stringValue(`https://www.inaturalist.org/photos/${rec.photoId}`))],
      P137: [valueSnak('P137', itemValue(QIDS.iNaturalist))],
    }));
  }

  if (isIsoDate(rec.observedOn)) {
    claims.push(statement(valueSnak('P571', {
      value: {
        time: `+${rec.observedOn}T00:00:00Z`,
        timezone: 0, before: 0, after: 0, precision: 11, calendarmodel: GREGORIAN,
      },
      type: 'time',
    })));
  }

  if (locationAllowed(rec)) {
    claims.push(statement(valueSnak('P1259', {
      value: {
        latitude: rec.lat, longitude: rec.lng, altitude: null,
        precision: coordPrecision(rec.accuracy), globe: EARTH,
      },
      type: 'globecoordinate',
    })));
  }

  return {
    labels: { en: { language: 'en', value: captionText(rec).slice(0, CAPTION_MAX) } },
    claims,
  };
}
