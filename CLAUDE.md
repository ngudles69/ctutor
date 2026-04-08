# Chinese Tutor — Architecture Notes

## No server

This app is a **purely client-side static web app**. There is no backend, no
database, no auth service, no push notifications. All data lives in
`localStorage` on each device.

When proposing features, **do not** suggest server-side state, websockets,
push notifications, account systems, or any approach that assumes a backend.
Anything cross-device must work over a transport the user already has on
their phone (WhatsApp, iMessage, AirDrop, email, etc).

## Cross-device sync — preferred route

The **only** cross-device sync mechanism is **Web Share API URL links**.
The kid's device and the parent's device exchange small payloads as URLs
that the user shares through whatever messenger they prefer. Tapping the
link opens the app and ingests the payload.

This is the preferred route for any future features that need to pass data
between the parent's and learner's devices. Add new message types here when
the existing three are not enough.

### Existing message types

All three use the same encoding: `JSON.stringify` → `LZString.compressToEncodedURIComponent` → URL query parameter. All three are dispatched via `navigator.share({ text: '... ' + url })` (single `text` field — splitting `text` and `url` makes iOS Messages send two bubbles).

| Param  | Direction       | Purpose                                              |
|--------|-----------------|------------------------------------------------------|
| `?d=`  | bidirectional   | Full Share Data — lessons, stickers, claims, skip state |
| `?sr=` | learner → parent| Skip request for one lesson                          |
| `?sa=` | parent → learner| Skip approval for one lesson                         |

`?import=` is a legacy alias for `?d=` kept for backward compatibility.

Ingest happens in `checkUrlImport()` at app init. The URL is cleaned with
`history.replaceState` so reloading does not re-prompt.

### Identity matching across devices

Lessons created independently on two devices have different IDs. To match
them, the merge logic (and skip request ingest) falls back from ID to a
**normalized name + phrases key** via `lessonKey()`. Always use this helper
when matching cross-device payloads to local lessons.

### Single-active-per-lesson rule

Skip requests/approvals are deduplicated per lesson by a unique `requestId`
(`rid`). Tapping "Ask to skip" or "Approve" multiple times reuses the same
`rid` and just re-fires the share — neither side gets duplicate state. New
ids are only generated when there is no existing pending or approved entry.

## Storage layout

Single localStorage key `ctutor_data` holds:

```js
{
  pin: '1357',
  lessons: [{
    id, name, phrases, createdAt, updatedAt?,
    completions: [{ id, cycle, score, date, note? }],
    progress?: { sectionScores, completedSections, revisionAttempts, tingxieResults },
    attempts?: [{ ... per-section attempt stats ... }],
    skipRequest?: { id, status: 'pending'|'approved', createdAt, approvedAt? }
  }],
  stickers: {
    owned: [pokemonId, ...],
    history: [{ id, lessonId, compId, date }],
    claims: { [pokemonId]: { claimedAt, comment } }
  }
}
```

Migrations run in `Storage._migrate()` — keep them additive and idempotent.

## External dependencies (CDN only)

- `hanzi-writer` — character stroke practice
- `lz-string` — URL payload compression
- PokeAPI sprites repo on jsDelivr — sticker images, referenced by id
  (`STICKER_BASE_URL` + id + `.png`)

Nothing is bundled. The app must keep working as a single-file static deploy.
