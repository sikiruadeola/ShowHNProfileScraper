# Lessons learned building these actors

This document exists for whichever AI agent, human, or future version of me
picks up work on this actor next. It is not a feature list, it is a record
of what actually happened while building this, including the things that
did not work the first time, so the same mistakes are not repeated.

## The general pattern across every platform here

Every one of these actors follows the same shape, and it is worth keeping
that shape rather than reinventing it per platform.

1. Prefer an official, documented API over browser automation, always.
   Browser automation should be the last resort, not the default. It is
   slower, costlier, and the only one of these actors that needed it
   (IMDbPro) also turned into the only one with real reliability problems.
2. Discovery and profile lookup are usually two separate steps. Most
   platforms do not expose a single "list every user" endpoint. Instead,
   walk through some content the people created (posts, projects, search
   results), collect the unique people behind it, then look up each
   person's own profile once.
3. Progress must survive between separate runs, not just within one run.
   Apify gives every run its own fresh, throwaway default key-value store.
   If state is saved there, it vanishes the moment the run ends and the
   next run starts from zero. Use `Actor.openKeyValueStore(\'some-fixed-name\')`
   instead of the default store, so every run reads and writes the same
   place. This bit us once, in the Show HN build, and cost a wasted test
   cycle to catch.
4. Type check locally before every single push, no exceptions, and after
   pushing, fetch the file back from GitHub and compare it byte for byte
   against what was meant to be sent. Do not trust that a push tool
   returning success means the content actually landed correctly.
5. Test small before testing big. A five or fifteen profile test costs
   fractions of a cent and catches almost everything a thousand profile
   run would catch, for a tiny fraction of the cost and time.
6. When something breaks, get real evidence before guessing again. A
   captured screenshot, a captured raw HTML dump, a full log, something
   concrete. Several hours were lost at different points guessing at causes
   that sounded reasonable but were not what was actually happening.

## Credentials: how to actually handle them

- A token or session only needs the exact scope the task requires, nothing
  more. Ask for a token with zero permissions ticked if the task is only
  ever reading public data, and only widen it if the platform\'s API
  specifically demands a scope for a field that is otherwise public
  (this happened with GitHub\'s GraphQL API, see below).
- If the repository is public, a live credential can never be embedded
  directly in the source code. GitHub\'s own push protection will block the
  push outright the moment it detects something that looks like a real
  token, this is a hard stop, not a warning. Pass credentials through the
  actor\'s run input instead, marked as a secret field, so they only ever
  live on Apify\'s side, never inside GitHub.
- If the repository is private, embedding a credential directly in the
  source becomes an option, but note that Apify\'s own git-based build
  system needs the repository to be public to clone it unless a private
  GitHub connection is separately configured on the Apify account. This
  bit us on the IMDbPro project\'s first build attempt, a `fatal: could not
  read Username` error, fixed by simply making that one repository public
  since nothing sensitive was in the code itself, only the runtime secret.

## Platform specific notes

### IMDbPro (browser automation, the hard one)

This one needed a real logged in session and full browser automation,
since IMDbPro has no public API and requires authentication to see contact
information at all. Everything below only applies because browser
automation was genuinely unavoidable here, not because it is a good
default choice.

**What actually went wrong, roughly in the order it happened:**

- Embedding a large JSON session (a Playwright storage state) directly
  inside a JS template literal string in the source code repeatedly got
  corrupted, the same exact escaping failure, several times, even after
  what looked like a clean local fix each time. The eventual root cause
  was that the GitHub file push tool being used auto detects whether
  incoming content is plain text or already base64 encoded, and that
  detection occasionally mishandled a pre-encoded base64 string, silently
  corrupting one specific byte sequence. The fix: never pre-encode content
  before pushing to GitHub, always send raw plain text and let the push
  tool do its own encoding. After that fix, a large embedded JSON value
  finally survived a push correctly, confirmed by decoding the file back
  from GitHub afterward and parsing it.
- The site\'s own contact information section only builds itself into the
  page after separate background data calls finish, well after the page
  itself has technically finished loading. A fixed multi-second sleep
  after navigation is not a substitute for actually waiting on that
  background activity to settle. The fix was `page.waitForLoadState(\'networkidle\')`
  after every navigation, not a hardcoded timeout.
- Automated browsing got outright blocked with a 403 after a period of
  unusually heavy testing in a short window, a clear bot detection
  response, confirmed by literally capturing the blocked page\'s HTML and
  seeing a script that disabled `document.cookie` reads and writes, a
  known bot mitigation technique. Waiting a long stretch of real time
  (roughly a day, tested at multiple shorter intervals first, all of which
  still failed) combined with routing through Apify\'s own rotating proxy
  addresses and a small set of standard browser stealth measures (hiding
  the automation flag, a realistic user agent, randomized pacing between
  actions instead of identical timing every time) eventually let requests
  through cleanly again. There is no guaranteed fast fix for this kind of
  block, time and looking less mechanically uniform are the only real
  levers.
- The shared, free proxy pool only has a handful of addresses in it, and
  individual addresses occasionally fail outright with a full connection
  timeout, not a clean rejection. The fix was retrying with a freshly
  requested proxy session if a connection level timeout happens, rather
  than treating one bad address as a hard failure.
- Clicking a page\'s own "copy to clipboard" button and then reading the
  clipboard back is unreliable inside an automated headless browser, it
  came back empty even after a confirmed successful click. Reading the
  visible text directly from the same page section instead is simpler and
  did not have this problem.
- The pagination logic originally stopped as soon as a single page came
  back with zero results, treating that as the end of the available range.
  This produced a false stop, a specific page that had genuinely failed to
  load properly was mistaken for a genuinely empty page, cutting a run
  short by roughly a hundred pages worth of real, unreachable data. The
  fix: never trust a single empty page, retry that same page once before
  believing it, and only treat several empty pages in a row as a genuine
  end of the range.
- A container\'s default `chromium.launch()` memory setting on Apify can
  default far higher than what an actual Playwright run needs. One run set
  to eight gigabytes of memory cost roughly eight times what the same run
  cost once turned down to one gigabyte, for identical work. Always set
  memory deliberately, do not accept whatever a console default happens to
  suggest.

### Show HN (Algolia\'s public search API)

No login needed at all. Discovery works by walking Hacker News\'s own
public, keyless Algolia search API (`hn.algolia.com/api/v1`) in fixed size
time windows moving forward chronologically, since the API only supports
descending sort by default and a genuinely full historical walk needs
manual date range slicing to get around that. Each unique poster\'s
username is then looked up individually through the same API\'s user
endpoint for their bio and any links in it.

The one real mistake here was the default key-value store issue described
above in the general pattern section, state looked like it was persisting
correctly within a single run, and only revealed itself as broken the
moment a second, genuinely separate run was tested.

### GitHub Sponsors (official GraphQL API)

Uses GitHub\'s own `sponsorables` GraphQL query, a single flat cursor
paginated list, no time windowing needed here since the API does not
expose activity dates for this list the way Algolia does. No browser
needed.

**What went wrong here:**

- A token with every permission checked works but is far riskier than the
  task needs, since this only ever reads already public data. The
  correction found afterward: even a token with zero scopes ticked at all
  was not actually enough. GitHub\'s GraphQL API gates certain individual
  fields, specifically a user\'s `email` field and an organization\'s
  `login`/`name` fields, behind the `read:user` and `read:org` scopes
  respectively, even though the underlying data is genuinely public. Two
  narrow, read only scopes were the actual minimum needed, not zero.
- Larger page sizes occasionally return a 502 from GitHub\'s own server,
  most likely the server having trouble assembling a large response for
  this particular query in one attempt. A smaller page size worked
  immediately when this happened, though a retest afterward showed the
  larger page size also working cleanly on its own, so this may simply be
  occasional server side flakiness rather than a hard size ceiling.
  Regardless, retrying the same page with a smaller size on any failure is
  a cheap, sensible safety net either way.

## What to do differently next time, in short

- Ask what exact fields are wanted before writing a single line of
  extraction logic, and confirm again if the underlying mechanism for
  getting that data changes mid build (this happened once, a switch away
  from clipboard copying quietly dropped a field, the profile link, that
  had previously been coming along for free as part of the copied text).
- Always prefer an API over a browser.
- Persist state in a named store, never the default one, the instant more
  than one run is expected to matter.
- Push plain text to GitHub, never pre-encoded content.
- Verify pushes and builds with real evidence, not assumption.
- Treat a single failed page, request, or empty result with suspicion
  before accepting it as a true signal, especially anywhere that failure
  would silently end a whole run early.
