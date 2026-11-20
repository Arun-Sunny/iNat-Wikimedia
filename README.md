# iNat → Commons

A small web app that lets photographers upload **their own** iNaturalist photos to Wikimedia Commons under their own Commons account. It fills in the species, date, location, license, categories and structured data automatically.

Anyone can use it: each person enters their own iNaturalist profile and logs in with their own Wikimedia account.

It is a static site: plain HTML, CSS and JavaScript with no server, no build step and no dependencies. It runs on GitHub Pages and works on phones and desktops.

**Live site:** <https://arun-sunny.github.io/iNat-Wikimedia/>

The app has a built-in **Help** page (the **?** button) with these instructions, including how to set up the Wikimedia login.

## What it does

1. **Load**: you paste your iNaturalist profile link (e.g. `https://www.inaturalist.org/people/yourname`) or type your username; the browser remembers it. The app then reads that account's observations from the public iNaturalist API, about one request per second. It pages with `id_above`, which avoids the API's 10,000-result cap. Data is cached in the browser, so later visits only fetch new observations.
2. **Choose**: shows every photo in a grid. Photos that can't go to Commons are greyed out with the reason: an NC/ND license, no license, below the minimum quality grade, no species, or hidden. "Add best photo of each species" picks the most-faved photo of each species that isn't on Commons yet.
3. **Check & preview**: for the selected photos, the app:
   - looks up the Commons category: the species, else the genus, else a fallback category;
   - finds the species' Wikidata item through P3151 (iNaturalist taxon ID);
   - checks whether the planned file name is already taken;
   - downloads the original photo and asks Commons whether a file with the same SHA-1 already exists;
   - shows the exact file name, description page wikitext and structured data that would be sent.
4. **Upload**: after logging in with Wikimedia, uploads the selected photos one at a time, 5 per run by default with 10 seconds between files. For each photo it:
   - downloads the original and checks Commons for an identical file again;
   - uploads it with `action=upload`, sending `maxlag=5` and never `ignorewarnings`. If Commons warns that the file is a duplicate, was deleted before, or has a name already in use, the photo is skipped with the reason shown. If Commons suggests a corrected file name, the app retries once with it;
   - adds the structured data to the new file with `wbeditentity`. If that fails, the upload stays, and **Add missing structured data** can retry it later;
   - waits out "servers busy" (maxlag) and rate-limit replies, and stops on login problems, a CAPTCHA, or 3 failures in a row.

## Own work or copied from iNaturalist

The **These are my own photos** box in step 1 decides how the photos are described:

- **Ticked:** the uploader took the photos. They're marked `{{own}}` and licensed with `{{self|cc-by-4.0}}`. The license review is optional (on by default in Settings).
- **Unticked** (e.g. uploading a relative's or friend's photos): the photos are marked as copied from iNaturalist and credited to the iNaturalist photographer, with the license template carrying their attribution (`{{Cc-by-4.0|1=…}}`). `{{iNaturalistreview}}` is always added, because Commons requires a license review for files copied from iNaturalist.

## What an upload looks like

- **File name:** `Saxicola maurus (iNaturalist 123456789-987654321).jpg`
- **Description page:**
  - `{{Information}}` with the species and common name, a link to the observation, `{{Taken on|<date>}}`, and source `{{own}}` plus the iNaturalist links.
  - Author: the photographer's iNaturalist profile, plus their Commons user page.
  - `{{Location}}`, only when the location is public on iNaturalist. It's left out for obscured or private observations, and for threatened species that iNaturalist hides.
  - `{{iNaturalist|<obs id>}}`.
  - `{{self|cc-by-4.0}}`, or the matching CC0 / CC BY-SA template.
  - `{{iNaturalistreview}}`, which asks Commons' review bot to confirm the license on iNaturalist.
  - Categories.
- **Structured data:** depicts (P180), creator (P170: unknown value with the author name, plus the Wikimedia username for own work, and a URL), copyright license (P275), copyright status (P6216), source of file (P7482: "original creation by uploader" for own work, or "file available on the internet" at the iNaturalist photo page, operated by iNaturalist, for copies), inception (P571), and coordinates of the point of view (P1259) when public.

Example wikitext is in [tests/golden/](tests/golden/).

---

## Using the app (each photographer)

1. **Have a Wikimedia account.** Create one at <https://commons.wikimedia.org/wiki/Special:CreateAccount> if needed. The same account works on all Wikimedia sites.
2. **Make sure your iNaturalist photos have a Commons-compatible license**: CC0, CC BY or CC BY-SA. The iNaturalist default, CC BY-NC, can't go to Commons. You can change the license of past photos in your iNaturalist account settings.
3. Open the app, paste your iNaturalist profile link, press **Use this account**, and tick **These are my own photos**.
4. Press **Log in with Wikimedia**. You type your username and password on Wikimedia's own login page, never in this app. Wikimedia then asks you to allow the app to upload and edit for you. The login lasts about 4 hours and is forgotten when the tab closes.

Recommended: link your two accounts, so Commons reviewers can see that the Commons account and the iNaturalist account belong to the same person.
- On iNaturalist, add your Commons username to your profile bio.
- On Commons, create your user page (`User:<your name>`) with a link to your iNaturalist profile.

New accounts: Commons sometimes asks brand-new accounts for a CAPTCHA, which this app can't show. The upload then stops with an explanation. Upload one file by hand on Commons, or wait until the account is "autoconfirmed" (4 days and 10 edits).

Bigger batches:
- Start with a handful of photos and look at the resulting Commons pages before doing more.
- A new account uploading thousands of files quickly can get flagged. Keep the delay between uploads (default 10 s) and go species by species.
- For hundreds or thousands of uploads, consider posting at [Commons:Batch uploading](https://commons.wikimedia.org/wiki/Commons:Batch_uploading), or asking for a bot flag at [Commons:Bots/Requests](https://commons.wikimedia.org/wiki/Commons:Bots/Requests). Ask at the [Village pump](https://commons.wikimedia.org/wiki/Commons:Village_pump) if unsure.

---

## Running your own copy (maintainers)

### 1. Publish on GitHub Pages

1. Push this folder to a public GitHub repository.
2. On GitHub, open **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, then **main** and **/ (root)**, and save.
3. After a minute or two the app is live at `https://<github-user>.github.io/<repo>/`. Its **Settings** (the gear icon) shows the exact **callback URL** to register in the next step. For this repository it is `https://arun-sunny.github.io/iNat-Wikimedia/`, including the capital letters and the final `/`.
4. Put your repository URL in `userAgent` in [js/config.js](js/config.js). Wikimedia asks tools to identify themselves.

### 2. Register the Wikimedia login (once per site)

The login is an OAuth 2.0 "consumer" registered once for the whole site. Every user then logs in with their own Wikimedia account through it.

**Approval matters.** Until Wikimedia's OAuth administrators approve the registration, only the account that registered it can log in. Everyone else can log in once it's approved, which can take a while. So register it from the account that should be able to use the app first.

1. Go to <https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2> while logged in.
2. Fill in the form. Labels may differ slightly.
   | Field | Value |
   | --- | --- |
   | Application name | `iNat to Commons` |
   | Consumer version | `1.0` |
   | Description | `Lets photographers upload their own openly licensed iNaturalist photos to Wikimedia Commons, with species, license, location and structured data filled in.` |
   | "This consumer is for use only by …" | **unchecked** (otherwise nobody else can ever use it) |
   | OAuth "callback" URL | the callback URL from the app's Settings |
   | Allow consumer to specify a callback | unchecked |
   | Client is confidential | **unchecked** (it's a browser app; it uses PKCE instead of a secret) |
   | Types of grants | "Request authorization for specific permissions" |
   | Applicable grants | **Basic rights**, **Edit existing pages**, **Create, edit, and move pages**, **Upload new files**. All four are needed: uploading a new file also creates its description page, which needs the "create pages" right. Without it, Commons answers "You do not have permission to create new pages." |
3. Accept the terms and submit.
4. Wikimedia shows a **client application key** and a **client application secret**. Copy the **key** only. The app never needs the secret: don't put it anywhere, and don't share it.
   After logging in, the app checks the permissions the login actually has, and disables uploading with a clear message if any are missing.

   Permissions can't be changed after registering. If one is missing, register again with the same name and a higher version (e.g. `1.1`), use the new key, and log out and in again.
5. Put the key in `clientId` under `environments.production` in [js/config.js](js/config.js), then commit and push. The client key is not secret, so it's fine in a public repository. To try it without committing, paste it in the app's Settings instead; that only saves it in that browser.

### Testing on the beta cluster (optional)

Wikimedia's test wikis now live at `*.beta.wmcloud.org`. The old `beta.wmflabs.org` addresses redirect there.

1. Create an account at <https://commons.wikimedia.beta.wmcloud.org/>. Beta accounts are separate from real ones.
2. Register an OAuth 2.0 consumer the same way at <https://meta.wikimedia.beta.wmcloud.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2>.
3. Put its key in `environments.beta.clientId` in [js/config.js](js/config.js), or in Settings.
4. In the app's Settings, choose **Beta Commons (test site)**. A "Test site" badge appears in the header.

Structured data is skipped on beta, because the beta Wikidata uses different item IDs from the real one.

### Running locally

ES modules and Web Crypto need a web server, so opening `index.html` as a file won't work.

```sh
python -m http.server 8080      # or: npm run serve
# open http://localhost:8080/
```

Loading, choosing and previewing work locally. Logging in needs an OAuth consumer whose callback is `http://localhost:8080/`.

### Tests

Requires Node 20 or newer. There are no packages to install, and no test uses the network: both APIs are faked, and all sample data is made up.

```sh
npm test
UPDATE_GOLDEN=1 npm test   # rewrite tests/golden/*.wikitext after an intended change
```

Covered: license mapping, file-name sanitising, wikitext rendering for own work and copies (golden files), structured data, iNaturalist paging (id_above, throttling, retries) and account parsing, eligibility rules, Commons and Wikidata lookups, the upload request format, upload warning handling, maxlag/rate-limit/token retries, and the OAuth/PKCE helpers.

### Configuration

The iNaturalist account is entered on the page, not in a file. The credit name and profile link come from that account; they can be overridden in Settings.

[js/config.js](js/config.js) holds:
- an optional preset iNaturalist account (normally empty);
- the API addresses for production and beta;
- the OAuth client IDs;
- the defaults for the Settings panel: minimum quality grade, fallback category, extra category, license review, batch size, upload limit and delay.

Everything in that file is public. Never put a password or client secret there.

## Privacy and safety

- No server: the login token goes straight from Wikimedia to the browser. It's kept in `sessionStorage`, never logged, and gone when the tab closes.
- Only observations by the chosen iNaturalist account can be selected. Photos count as the uploader's own work only when "These are my own photos" is ticked; otherwise they're credited to the iNaturalist photographer. Changing the account unticks it.
- Coordinates and place names are omitted for observations iNaturalist shows as obscured or private.
- Open observations keep their exact public coordinates, as on iNaturalist. Change an observation's geoprivacy on iNaturalist first if a spot shouldn't be pinpointed, such as your home.
- Duplicate check: a photo already on Commons (same bytes) is marked and can't be selected.

## Project layout

```
index.html          page structure
css/app.css         styles (light and dark, mobile first)
js/config.js        settings you edit
js/app.js           UI
js/lib/inat.js      iNaturalist API paging, account lookup and record parsing
js/lib/plan.js      eligibility, location rules, best photo per species
js/lib/license.js   iNaturalist license → Commons template and Wikidata item
js/lib/filename.js  Commons file names
js/lib/wikitext.js  description page
js/lib/sdc.js       structured data
js/lib/commons.js   Commons API client (reads, upload, wbeditentity)
js/lib/uploader.js  one photo's upload: duplicate check, warnings, retries, structured data
js/lib/wikidata.js  P3151 lookups
js/lib/oauth.js     OAuth 2.0 + PKCE
js/lib/cache.js     IndexedDB cache
tests/              node:test unit tests and golden files
```
