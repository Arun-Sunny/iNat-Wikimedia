import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSdc, coordPrecision, userPageUrl } from '../js/lib/sdc.js';
import { toPhotoRecords } from '../js/lib/inat.js';
import { sampleObservation } from './helpers.js';

const ctx = {
  authorName: 'Alex Example',
  authorUrl: 'https://www.inaturalist.org/people/example_naturalist',
  commonsUser: 'Alex Example',
  depictsQid: 'Q1589281',
};
const byProp = (sdc, p) => sdc.claims.filter((c) => c.mainsnak.property === p);

test('builds depicts, creator, license, status, source, inception and coordinates', () => {
  const [rec] = toPhotoRecords(sampleObservation());
  const sdc = buildSdc(rec, ctx);

  assert.deepEqual(sdc.labels, { en: { language: 'en', value: 'Saxicola maurus (Siberian Stonechat)' } });
  assert.deepEqual(sdc.claims.map((c) => c.mainsnak.property), ['P180', 'P170', 'P275', 'P6216', 'P7482', 'P571', 'P1259']);

  assert.equal(byProp(sdc, 'P180')[0].mainsnak.datavalue.value.id, 'Q1589281');
  assert.equal(byProp(sdc, 'P180')[0].mainsnak.datavalue.value['numeric-id'], 1589281);

  const creator = byProp(sdc, 'P170')[0];
  assert.equal(creator.mainsnak.snaktype, 'somevalue');
  assert.equal(creator.qualifiers.P2093[0].datavalue.value, 'Alex Example');
  assert.equal(creator.qualifiers.P4174[0].datavalue.value, 'Alex Example');
  assert.equal(creator.qualifiers.P2699[0].datavalue.value, 'https://commons.wikimedia.org/wiki/User:Alex_Example');
  assert.deepEqual(creator['qualifiers-order'], ['P2093', 'P4174', 'P2699']);

  assert.equal(byProp(sdc, 'P275')[0].mainsnak.datavalue.value.id, 'Q20007257');
  assert.equal(byProp(sdc, 'P6216')[0].mainsnak.datavalue.value.id, 'Q50423863');
  assert.equal(byProp(sdc, 'P7482')[0].mainsnak.datavalue.value.id, 'Q66458942');

  const inception = byProp(sdc, 'P571')[0].mainsnak.datavalue;
  assert.equal(inception.type, 'time');
  assert.equal(inception.value.time, '+2024-05-12T00:00:00Z');
  assert.equal(inception.value.precision, 11);

  const coords = byProp(sdc, 'P1259')[0].mainsnak.datavalue;
  assert.equal(coords.type, 'globecoordinate');
  assert.equal(coords.value.latitude, 12.3456789012);
  assert.equal(coords.value.longitude, 76.5432109876);
  assert.equal(coords.value.precision, 0.01);
  assert.equal(coords.value.globe, 'http://www.wikidata.org/entity/Q2');
});

test('leaves out coordinates for obscured observations and depicts when no item is known', () => {
  const [rec] = toPhotoRecords(sampleObservation({ obscured: true, geoprivacy: 'obscured' }));
  const sdc = buildSdc(rec, { ...ctx, depictsQid: null });
  assert.equal(byProp(sdc, 'P1259').length, 0);
  assert.equal(byProp(sdc, 'P180').length, 0);
});

test('credits the iNaturalist profile when the Commons username is unknown', () => {
  const [rec] = toPhotoRecords(sampleObservation());
  const creator = byProp(buildSdc(rec, { ...ctx, commonsUser: null }), 'P170')[0];
  assert.equal(creator.qualifiers.P4174, undefined);
  assert.equal(creator.qualifiers.P2699[0].datavalue.value, 'https://www.inaturalist.org/people/example_naturalist');
});

test('transfer mode: source is the iNaturalist photo page, creator has no Commons username', () => {
  const [rec] = toPhotoRecords(sampleObservation());
  const sdc = buildSdc(rec, { ...ctx, commonsUser: 'Someone Else', ownWork: false });
  const creator = byProp(sdc, 'P170')[0];
  assert.equal(creator.qualifiers.P2093[0].datavalue.value, 'Alex Example');
  assert.equal(creator.qualifiers.P4174, undefined);
  assert.equal(creator.qualifiers.P2699[0].datavalue.value, 'https://www.inaturalist.org/people/example_naturalist');
  const source = byProp(sdc, 'P7482')[0];
  assert.equal(source.mainsnak.datavalue.value.id, 'Q74228490');
  assert.equal(source.qualifiers.P973[0].datavalue.value, 'https://www.inaturalist.org/photos/987654321');
  assert.equal(source.qualifiers.P137[0].datavalue.value.id, 'Q16958215');
  assert.deepEqual(source['qualifiers-order'], ['P973', 'P137']);
});

test('coordinate precision follows the accuracy radius', () => {
  assert.equal(coordPrecision(1953), 0.01);
  assert.equal(coordPrecision(5), 0.00001);
  assert.equal(coordPrecision(null), 0.0001);
  assert.equal(coordPrecision(500000), 1);
});

test('user page URLs use underscores', () => {
  assert.equal(userPageUrl('Alex Example'), 'https://commons.wikimedia.org/wiki/User:Alex_Example');
});
