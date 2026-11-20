// Test doubles for fetch. No test touches the network.

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** fetch stand-in: `handler(url: URL, init, callNumber)` returns a Response. Calls are recorded. */
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    return handler(u, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** A sample iNaturalist v1 observation, shaped like the real API's output. */
export function sampleObservation(overrides = {}) {
  return {
    id: 123456789,
    uri: 'https://www.inaturalist.org/observations/123456789',
    observed_on: '2024-05-12',
    quality_grade: 'research',
    location: '12.3456789012,76.5432109876',
    positional_accuracy: 1953,
    public_positional_accuracy: 1953,
    geoprivacy: null,
    taxon_geoprivacy: null,
    obscured: false,
    place_guess: 'Example Park, Example City',
    faves_count: 0,
    user: { login: 'example_naturalist', name: 'Alex Example' },
    taxon: {
      id: 201193,
      name: 'Saxicola maurus',
      rank: 'species',
      preferred_common_name: 'Siberian Stonechat',
    },
    photos: [
      {
        id: 987654321,
        license_code: 'cc-by',
        url: 'https://inaturalist-open-data.s3.amazonaws.com/photos/987654321/square.jpg',
        original_dimensions: { width: 1600, height: 1044 },
      },
    ],
    ...overrides,
  };
}
